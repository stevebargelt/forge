// FG-425: the publication target — one interface, two implementations.
//
// A target is the thing a validated candidate gets published TO. Publication is
// ALWAYS compare-and-swap against the base SHA captured before validation began,
// and ALWAYS lands the RECORDED candidate SHA (AD-6) — never a branch tip, never
// whatever a worktree happens to contain now.
//
// THE TWO CHECKS, AND WHY NEITHER SUBSTITUTES FOR THE OTHER:
//   (a) ANCESTRY PROOF — candidateSha must descend from baseSha. Computed BEFORE
//       any mutation (and, for a remote, before any network write).
//   (b) COMPARE-AND-SWAP — the target must still be AT baseSha at the moment of
//       the write.
// (b) alone is NOT enough. `git push --force-with-lease` carries FORCE semantics:
// once its expected-SHA check matches, it will happily push a NON-fast-forward
// candidate and discard target history. The lease constrains the BASE of the
// update, not its SHAPE. A naked lease push with no separate ancestry proof would
// therefore permit exactly the history rewrite this ticket exists to prevent.
// (a) alone is not enough either: ancestry is computed against a base that may
// have moved by the time the write lands. Both, in that order, every time.
//
// The implicit lease form (`--force-with-lease` with no expected value) is NEVER
// used: it reads a local remote-tracking ref, which a concurrent `git fetch` can
// poison into agreeing with a base we never validated against.

import { execFileSync } from "node:child_process";

export type LocalTarget = {
  kind: "local";
  /** The repo whose checked-out branch is being published to. */
  projectDir: string;
  /** Short branch name, e.g. "main". */
  branch: string;
};

export type RemoteTarget = {
  kind: "remote";
  /** Local repo holding the candidate objects; the push runs from here. */
  projectDir: string;
  /** Remote name or URL. */
  remote: string;
  branch: string;
};

export type PublicationTarget = LocalTarget | RemoteTarget;

/** The durable, operator-visible target descriptor recorded on every attempt. */
export function targetDescriptor(t: PublicationTarget): string {
  return t.kind === "local"
    ? `local:${t.projectDir}#${t.branch}`
    : `remote:${t.remote}#${t.branch}`;
}

function refOf(t: PublicationTarget): string {
  return `refs/heads/${t.branch}`;
}

/** AD-3: a dirty local publish target is a NAMED blocker, refused BEFORE any
 *  mutation. Operator-owned dirty state is NEVER stashed, reset, cleaned, or
 *  checked out over.
 *
 *  TWO shapes of operator-owned state block a publish, and BOTH are refused here,
 *  before anything is written:
 *
 *    - `tracked`   — uncommitted changes to files git already knows about. The
 *                    checkout update would have to overwrite them.
 *    - `untracked` — files git does NOT know about, which the candidate ADDS.
 *                    This one is not hypothetical: `read-tree -m -u` refuses to
 *                    clobber an untracked file ("would be overwritten by merge"),
 *                    and it refuses AFTER the ref has already advanced. Leaving
 *                    that check to git means discovering the collision on the far
 *                    side of the CAS, with the target half-published. So the
 *                    collision is computed HERE, from the base→candidate diff
 *                    against the target's untracked set, and refused before the
 *                    mutex window does anything at all. */
export class DirtyPublishTargetError extends Error {
  readonly reason = "dirty_publish_target" as const;
  constructor(
    public readonly canonicalDir: string,
    public readonly dirtyFiles: string[],
    public readonly shape: "tracked" | "untracked" = "tracked",
  ) {
    const listed = `${dirtyFiles.slice(0, 5).join(", ")}${dirtyFiles.length > 5 ? `, +${dirtyFiles.length - 5} more` : ""}`;
    super(
      shape === "tracked"
        ? `dirty_publish_target: ${canonicalDir} has uncommitted tracked changes (${listed}). ` +
            `Refusing to publish over operator-owned state — forge will never stash, reset, or clean it. ` +
            `Commit or stash the changes, then re-run \`forge next\`.`
        : `dirty_publish_target: ${canonicalDir} has untracked file(s) the validated candidate would overwrite ` +
            `(${listed}). Refusing BEFORE any mutation — forge will never delete, stash, or check out over an ` +
            `untracked file it did not create. Commit, move, or remove the file(s), then re-run \`forge next\`.`,
    );
    this.name = "DirtyPublishTargetError";
  }
}

/** The candidate does not descend from the base it was validated against.
 *  Publication is REFUSED — no push, no ref write, no state change. */
export class NonFastForwardError extends Error {
  readonly reason = "non_fast_forward" as const;
  constructor(public readonly baseSha: string, public readonly candidateSha: string) {
    super(
      `refusing to publish ${candidateSha.slice(0, 12)}: it does not descend from the validated base ` +
        `${baseSha.slice(0, 12)}. Publishing it would rewrite target history. A compare-and-swap lease is ` +
        `only a stale-base guard — it is never authorization for a non-fast-forward update.`,
    );
    this.name = "NonFastForwardError";
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** True iff `ancestor` is an ancestor of `descendant` — the fast-forward proof. */
export function isAncestor(repoDir: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** The target's CURRENT sha, read from the REF (never from working-tree state). */
export function readTargetSha(t: PublicationTarget): string {
  if (t.kind === "local") return git(t.projectDir, ["rev-parse", refOf(t)]);
  const out = git(t.projectDir, ["ls-remote", t.remote, refOf(t)]);
  const first = out.split("\n")[0]?.trim() ?? "";
  const sha = first.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not read remote target sha for ${targetDescriptor(t)} (ls-remote returned "${out}")`);
  }
  return sha;
}

/** Tracked-dirt: uncommitted changes to files git already knows about, matching
 *  preflightWorktreeGate's own definition of dirty (`git diff --quiet HEAD`). */
export function dirtyTrackedFiles(projectDir: string): string[] {
  const out = git(projectDir, ["status", "--porcelain", "--untracked-files=no"]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Untracked (and not ignored) paths in the target's working tree. `--exclude-standard`
 *  matches what `read-tree -m -u` itself protects: git will happily overwrite an
 *  IGNORED file, and refuses only on an untracked-and-not-ignored one. */
function untrackedFiles(projectDir: string): string[] {
  const out = git(projectDir, ["ls-files", "--others", "--exclude-standard"]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The paths base→candidate touches. These are exactly the paths the checkout
 *  update will write, and therefore the only ones that can collide. */
function pathsTouchedByCandidate(repoDir: string, baseSha: string, candidateSha: string): string[] {
  const out = git(repoDir, ["diff", "--name-only", baseSha, candidateSha]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Untracked files in the target that the candidate would clobber (AD-3).
 *  Computed BEFORE any mutation — see DirtyPublishTargetError's header for why
 *  letting `read-tree` discover this on the far side of the ref advance is the
 *  bug and not the check. */
export function untrackedCollisions(
  projectDir: string,
  baseSha: string,
  candidateSha: string,
): string[] {
  const untracked = new Set(untrackedFiles(projectDir));
  if (untracked.size === 0) return [];
  return pathsTouchedByCandidate(projectDir, baseSha, candidateSha).filter((p) => untracked.has(p));
}

/** The local checked-out branch, i.e. the default publish target of a repo. */
export function localTargetFor(projectDir: string): LocalTarget {
  let branch: string;
  try {
    branch = git(projectDir, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    throw new Error(
      `${projectDir} has no checked-out branch (detached HEAD) — forge cannot publish to it. ` +
        `Check out the target branch and re-run.`,
    );
  }
  return { kind: "local", projectDir, branch };
}

/** Rebuild a target from the descriptor RECORDED on the attempt (AD-5): recovery
 *  reads the ref the publication actually advanced, never whatever HEAD happens
 *  to point at now. localTargetFor() is the wrong tool for recovery — it re-derives
 *  the branch from the CURRENT symbolic-ref, so an operator who checked out a
 *  different branch (or detached HEAD) after the crash would have recovery read
 *  the WRONG ref, or throw outright. The descriptor is the record; parse it. */
export function parseTargetDescriptor(descriptor: string): PublicationTarget {
  const hash = descriptor.lastIndexOf("#");
  if (hash === -1) throw new Error(`malformed publication target descriptor: ${descriptor}`);
  const branch = descriptor.slice(hash + 1);
  if (descriptor.startsWith("local:")) {
    return { kind: "local", projectDir: descriptor.slice("local:".length, hash), branch };
  }
  if (descriptor.startsWith("remote:")) {
    // remote:<remote>#<branch>. The push runs from the attempt's canonical dir,
    // which the caller supplies — it is not part of the descriptor.
    return { kind: "remote", projectDir: "", remote: descriptor.slice("remote:".length, hash), branch };
  }
  throw new Error(`unknown publication target kind in descriptor: ${descriptor}`);
}

export type PublishResult =
  | { ok: true; publishedSha: string }
  /** The target moved off the validated base. Nothing was written. */
  | { ok: false; kind: "cas_lost"; currentSha: string };

export type PublishOpts = {
  /** Test-only seam: fires BETWEEN the local ref advance and the checked-out
   *  working-tree update — the exact AD-5 window. Undefined in production, so
   *  this is inert on every real publish. A test passes a callback that kills
   *  the process here, leaving precisely the durable state a real crash leaves;
   *  recoverCheckout() must then converge from {baseSha, candidateSha,
   *  currentTargetSha} ALONE. */
  afterRefAdvance?: () => void;
};

/** Publish the RECORDED candidate to the target. Both checks, in order.
 *
 *  Throws NonFastForwardError (ancestry) or DirtyPublishTargetError (AD-3) with
 *  NO mutation performed. Returns cas_lost when the target moved off baseSha.
 *
 *  The caller holds the short publication mutex across this call and nothing
 *  else — validation NEVER runs inside it. */
export function publishToTarget(
  t: PublicationTarget,
  baseSha: string,
  candidateSha: string,
  opts?: PublishOpts,
): PublishResult {
  // (a) ANCESTRY PROOF — before any mutation, local or remote.
  if (!isAncestor(t.projectDir, baseSha, candidateSha)) {
    throw new NonFastForwardError(baseSha, candidateSha);
  }
  return t.kind === "local"
    ? publishLocal(t, baseSha, candidateSha, opts)
    : publishRemote(t, baseSha, candidateSha);
}

function publishLocal(
  t: LocalTarget,
  baseSha: string,
  candidateSha: string,
  opts?: PublishOpts,
): PublishResult {
  // AD-3: refuse a dirty target BEFORE anything is written — BOTH shapes.
  const dirty = dirtyTrackedFiles(t.projectDir);
  if (dirty.length > 0) throw new DirtyPublishTargetError(t.projectDir, dirty, "tracked");
  const collisions = untrackedCollisions(t.projectDir, baseSha, candidateSha);
  if (collisions.length > 0) throw new DirtyPublishTargetError(t.projectDir, collisions, "untracked");

  const current = readTargetSha(t);
  if (current !== baseSha) return { ok: false, kind: "cas_lost", currentSha: current };

  // (b) COMPARE-AND-SWAP. `update-ref <ref> <new> <old>` is atomic at the git
  // level: it fails if the ref is not still at <old>. The candidate SHA is
  // passed EXPLICITLY — the candidate branch's tip is never consulted, so a
  // branch mutated after validation cannot change what lands (AD-6).
  try {
    git(t.projectDir, ["update-ref", refOf(t), candidateSha, baseSha]);
  } catch {
    return { ok: false, kind: "cas_lost", currentSha: readTargetSha(t) };
  }

  // ── AD-5 WINDOW ────────────────────────────────────────────────────────────
  // The ref has advanced; the checked-out working tree has not yet caught up. A
  // crash HERE is recoverable from {baseSha, candidateSha, currentTargetSha}
  // alone — see recoverCheckout. Publication state is NEVER inferred from
  // working-tree contents, which are ambiguous mid-checkout.
  opts?.afterRefAdvance?.();

  try {
    syncCheckout(t, candidateSha);
  } catch (e) {
    // A checkout FAILURE (not a crash) after the ref advanced is the one thing a
    // publication must never leave behind: the ref carries the candidate while the
    // index and working tree still carry the base, so every LATER publication's
    // AD-3 pre-check sees the whole diff as tracked dirt and refuses — the target
    // is wedged, permanently, by a publication that reported nothing.
    //
    // So we UNDO our own ref advance, by CAS, and refuse. The CAS is what makes
    // this safe: `update-ref <ref> <base> <candidate>` only lands if the ref is
    // STILL the candidate we just wrote — i.e. only if we are undoing our own
    // write and nobody else's. We hold the publication mutex, so nothing
    // forge-owned can be in here with us; an external writer that got in anyway
    // fails the CAS and we leave their commit alone and report the publication as
    // landed (the ref moved past us; recovery re-derives the truth from the REF).
    //
    // The result is a target that is byte-for-byte where it started: nothing
    // published, nothing staged, nothing to clean up, and the NEXT publication is
    // not blocked. This is the AD-5 rule applied to a failure rather than a crash
    // — state is defined, idempotent, and derived from the three SHAs alone.
    try {
      git(t.projectDir, ["update-ref", refOf(t), baseSha, candidateSha]);
    } catch {
      return { ok: true, publishedSha: candidateSha };
    }
    throw new CheckoutSyncError(t.projectDir, candidateSha, (e as Error).message);
  }
  // AD-6: what landed IS the recorded candidate. Never a readback of the target —
  // an external writer racing the readback would otherwise turn a publication that
  // ACTUALLY LANDED into a churn park claiming nothing was published. The CAS
  // above wrote exactly candidateSha, or it failed; there is no third outcome.
  return { ok: true, publishedSha: candidateSha };
}

/** The checked-out tree could not be brought up to the (already advanced) ref, so
 *  the ref advance was rolled back by CAS. NOTHING was published and the target is
 *  exactly where it started — this is a refusal, not a half-landed publication. */
export class CheckoutSyncError extends Error {
  readonly reason = "checkout_sync_failed" as const;
  constructor(public readonly projectDir: string, public readonly candidateSha: string, detail: string) {
    super(
      `refusing to publish ${candidateSha.slice(0, 12)}: the target ref advanced but ${projectDir}'s checked-out ` +
        `working tree could not be updated to it (${detail}). The ref advance has been ROLLED BACK by ` +
        `compare-and-swap — nothing was published and the target is unchanged, so the next publication is not ` +
        `blocked. Resolve the working-tree state and re-run \`forge next\`.`,
    );
    this.name = "CheckoutSyncError";
  }
}

/** Bring the checked-out working tree and index up to the (already advanced) ref.
 *
 *  `read-tree -m -u`, deliberately, and NOT `reset --keep` or `reset --hard`:
 *
 *    - `reset` works relative to HEAD, and HEAD has ALREADY moved (that is what
 *      the CAS above did). It would see HEAD === candidate, conclude there is
 *      nothing to update, and leave the working tree sitting at the old base —
 *      silently, with the ref advanced. That is the crash window, not a fix for it.
 *    - `read-tree -m -u` works from the INDEX, which is still at the base. It
 *      performs the two-way base→candidate update of index and working tree, and
 *      it REFUSES ("not uptodate") rather than overwriting a locally-modified
 *      file. AD-3 already refused a dirty target under the mutex; this is the
 *      belt to that pair of braces, and the belt matters — the one thing forge
 *      must never do is destroy operator work.
 *
 *  Idempotent: when index and working tree already match the candidate this is a
 *  no-op, which is what makes AD-5 recovery safe to re-run after a crash at any
 *  step. */
function syncCheckout(t: LocalTarget, candidateSha: string): void {
  git(t.projectDir, ["read-tree", "-m", "-u", candidateSha]);
}

/** AD-5 recovery. Derived ONLY from the three SHAs — the working tree is never
 *  inspected to decide what happened. Idempotent and safe to re-run after a crash
 *  at any step. */
export type RecoveryOutcome =
  | { state: "not_published" }
  | { state: "published"; publishedSha: string; checkoutError?: string }
  | { state: "external_writer"; currentSha: string };

export function recoverCheckout(
  t: PublicationTarget,
  baseSha: string,
  candidateSha: string,
): RecoveryOutcome {
  const current = readTargetSha(t);
  if (current === baseSha) return { state: "not_published" };
  if (current !== candidateSha) return { state: "external_writer", currentSha: current };
  // The ref carries the candidate: the CAS succeeded and the publication IS
  // durable. Only the checked-out tree may still be behind — re-run the update.
  //
  // AD-6: publishedSha is the RECORDED candidateSha, asserted equal to the ref
  // above — never re-derived from a second read of the target.
  //
  // A crash (unlike the failure path in publishLocal) can leave the ref advanced
  // with no rollback, and the checkout may then be un-runnable — an untracked file
  // now sits where the candidate wants one. That does NOT un-publish anything: the
  // ref is the publication. Report it landed, and hand the operator the checkout
  // error rather than throwing recovery itself into a loop.
  if (t.kind === "local") {
    try {
      syncCheckout(t, candidateSha);
    } catch (e) {
      return { state: "published", publishedSha: candidateSha, checkoutError: (e as Error).message };
    }
  }
  return { state: "published", publishedSha: candidateSha };
}

function publishRemote(t: RemoteTarget, baseSha: string, candidateSha: string): PublishResult {
  // The ancestry proof already ran in publishToTarget — BEFORE this network
  // write, which is the whole point: no push may happen until the candidate is
  // proven to be a fast-forward of the validated base.
  //
  // The lease is EXPLICIT (<ref>:<baseSha>), never the implicit form. It is the
  // atomic stale-base guard and nothing more.
  try {
    execFileSync(
      "git",
      [
        "push",
        `--force-with-lease=${refOf(t)}:${baseSha}`,
        t.remote,
        `${candidateSha}:${refOf(t)}`,
      ],
      { cwd: t.projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const stderr = String((e as { stderr?: string | Buffer }).stderr ?? "");
    // A rejected lease means the remote moved off the base we validated against.
    if (/stale info|rejected|non-fast-forward|fetch first/i.test(stderr)) {
      return { ok: false, kind: "cas_lost", currentSha: readTargetSha(t) };
    }
    throw new Error(`push to ${targetDescriptor(t)} failed: ${stderr.trim() || String(e)}`);
  }
  // AD-6: the push pushed `<candidateSha>:<ref>` and git reported success, so the
  // remote ref IS the candidate. A second `ls-remote` to "confirm" it would only
  // introduce the race it pretends to close — an external writer landing between
  // the push and the readback would make a publication that DID land look like one
  // that didn't. publishedSha is the recorded SHA, full stop.
  return { ok: true, publishedSha: candidateSha };
}
