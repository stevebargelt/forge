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

/** THE CEILING ON ONE OP INSIDE THE WINDOW, and the reason the publication mutex
 *  is safe to expire at all.
 *
 *  The window is a SYNCHRONOUS span — execFileSync blocks the event loop — so the
 *  holder's mutex lease cannot be renewed by a heartbeat, and an UNBOUNDED op (a
 *  `read-tree -m -u` over a huge tree on a slow disk) could therefore outlive a
 *  fixed TTL while the holder was still mid-checkout. A second attempt would then
 *  read the lease as lapsed and enter its own CAS+checkout concurrently: the CAS
 *  still protects ref ancestry, but NOTHING would serialize the two working-tree
 *  updates.
 *
 *  So each op is bounded HERE (execFileSync kills the child at the bound), the
 *  holder renews its lease BETWEEN ops, and the publisher DERIVES its mutex TTL
 *  from this constant — never a duplicated literal. A live holder can then never be
 *  inside the window when its lease lapses, which is exactly what takeover assumes.
 *  A blown ceiling surfaces as a checkout failure, which publishLocal already
 *  rolls back by CAS. */
export const WINDOW_GIT_TIMEOUT_MS = 120_000;

/** Renew the caller's hold on the publication window. Called immediately BEFORE
 *  each git op the window makes; it THROWS if the hold is gone, so an attempt that
 *  lost the mutex stops writing rather than racing the attempt that took it. */
export type RenewHold = () => void;

function git(cwd: string, args: string[], renew?: RenewHold): string {
  renew?.();
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: WINDOW_GIT_TIMEOUT_MS,
  }).trim();
}

/** True iff `ancestor` is an ancestor of `descendant` — the fast-forward proof. */
export function isAncestor(repoDir: string, ancestor: string, descendant: string, renew?: RenewHold): boolean {
  renew?.();
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: WINDOW_GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** The target's CURRENT sha, read from the REF (never from working-tree state). */
export function readTargetSha(t: PublicationTarget, renew?: RenewHold): string {
  if (t.kind === "local") return git(t.projectDir, ["rev-parse", refOf(t)], renew);
  const out = git(t.projectDir, ["ls-remote", t.remote, refOf(t)], renew);
  const first = out.split("\n")[0]?.trim() ?? "";
  const sha = first.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not read remote target sha for ${targetDescriptor(t)} (ls-remote returned "${out}")`);
  }
  return sha;
}

/** Tracked-dirt: uncommitted changes to files git already knows about, matching
 *  preflightWorktreeGate's own definition of dirty (`git diff --quiet HEAD`). */
export function dirtyTrackedFiles(projectDir: string, renew?: RenewHold): string[] {
  const out = git(projectDir, ["status", "--porcelain", "--untracked-files=no"], renew);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Untracked (and not ignored) paths in the target's working tree. `--exclude-standard`
 *  matches what `read-tree -m -u` itself protects: git will happily overwrite an
 *  IGNORED file, and refuses only on an untracked-and-not-ignored one. */
function untrackedFiles(projectDir: string, renew?: RenewHold): string[] {
  const out = git(projectDir, ["ls-files", "--others", "--exclude-standard"], renew);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The paths base→candidate touches. These are exactly the paths the checkout
 *  update will write, and therefore the only ones that can collide. */
function pathsTouchedByCandidate(
  repoDir: string,
  baseSha: string,
  candidateSha: string,
  renew?: RenewHold,
): string[] {
  const out = git(repoDir, ["diff", "--name-only", baseSha, candidateSha], renew);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Every proper directory prefix of a path: "a/b/c" → ["a", "a/b"]. */
function pathPrefixes(p: string): string[] {
  const parts = p.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** Untracked files in the target that the candidate would clobber (AD-3).
 *  Computed BEFORE any mutation — see DirtyPublishTargetError's header for why
 *  letting `read-tree` discover this on the far side of the ref advance is the
 *  bug and not the check.
 *
 *  PREFIX-AWARE, because git's collisions are: a path is a FILE or a DIRECTORY and
 *  it cannot be both. Exact equality catches only one of the three shapes:
 *
 *    - EXACT     — candidate writes `foo`; the operator has untracked `foo`.
 *    - ANCESTOR  — candidate writes `foo/bar`, so it needs `foo` to be a DIRECTORY;
 *                  the operator has an untracked FILE at `foo`.
 *    - DESCENDANT— candidate writes the FILE `foo`; the operator has untracked
 *                  `foo/bar`, so `foo` is a directory in their tree.
 *
 *  All three make `read-tree -m -u` fail, and it fails on the FAR SIDE of the ref
 *  advance. All three are therefore refused HERE, before anything is written. The
 *  paths reported are the OPERATOR'S — the files forge will never touch. */
export function untrackedCollisions(
  projectDir: string,
  baseSha: string,
  candidateSha: string,
  renew?: RenewHold,
): string[] {
  const untracked = untrackedFiles(projectDir, renew);
  if (untracked.length === 0) return [];
  const untrackedSet = new Set(untracked);
  const collisions = new Set<string>();
  for (const p of pathsTouchedByCandidate(projectDir, baseSha, candidateSha, renew)) {
    if (untrackedSet.has(p)) collisions.add(p);
    for (const prefix of pathPrefixes(p)) {
      if (untrackedSet.has(prefix)) collisions.add(prefix);
    }
    for (const u of untracked) {
      if (u.startsWith(`${p}/`)) collisions.add(u);
    }
  }
  return [...collisions];
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
  /** The caller's hold on the publication window, renewed before every git op the
   *  window makes (see WINDOW_GIT_TIMEOUT_MS). It THROWS if the hold is gone, so a
   *  publisher that lost the mutex stops rather than updating a working tree
   *  another attempt now owns. */
  renewHold?: RenewHold;
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
  if (!isAncestor(t.projectDir, baseSha, candidateSha, opts?.renewHold)) {
    throw new NonFastForwardError(baseSha, candidateSha);
  }
  return t.kind === "local"
    ? publishLocal(t, baseSha, candidateSha, opts)
    : publishRemote(t, baseSha, candidateSha, opts);
}

function publishLocal(
  t: LocalTarget,
  baseSha: string,
  candidateSha: string,
  opts?: PublishOpts,
): PublishResult {
  const renew = opts?.renewHold;

  // AD-3: refuse a dirty target BEFORE anything is written — BOTH shapes.
  const dirty = dirtyTrackedFiles(t.projectDir, renew);
  if (dirty.length > 0) throw new DirtyPublishTargetError(t.projectDir, dirty, "tracked");
  const collisions = untrackedCollisions(t.projectDir, baseSha, candidateSha, renew);
  if (collisions.length > 0) throw new DirtyPublishTargetError(t.projectDir, collisions, "untracked");

  const current = readTargetSha(t, renew);
  if (current !== baseSha) return { ok: false, kind: "cas_lost", currentSha: current };

  // The LAST renewal before we mutate anything: from here on the window is
  // provably ours, or we do not write. Renewing inside the try below would let a
  // lost-hold throw be swallowed as `cas_lost` and trigger a rebuild, which is a
  // very different (and wrong) story about what happened.
  renew?.();

  // (b) COMPARE-AND-SWAP. `update-ref <ref> <new> <old>` is atomic at the git
  // level: it fails if the ref is not still at <old>. The candidate SHA is
  // passed EXPLICITLY — the candidate branch's tip is never consulted, so a
  // branch mutated after validation cannot change what lands (AD-6).
  try {
    git(t.projectDir, ["update-ref", refOf(t), candidateSha, baseSha]);
  } catch {
    // The CAS failed, and there are two very different reasons it can have. If we
    // still hold the window, an EXTERNAL writer moved the ref and `cas_lost` is the
    // truth — the caller rebuilds on the new base. If our lease lapsed in the sliver
    // between the renewal above and this write, the attempt that TOOK the window is
    // what moved the ref, and reporting `cas_lost` would send us off to rebuild and
    // re-enter a window we no longer own. So prove the hold before naming the cause:
    // renew?.() throws if it is gone, and the publisher fails closed. It is safe to
    // throw from here — the CAS failed, so nothing was written.
    renew?.();
    return { ok: false, kind: "cas_lost", currentSha: readTargetSha(t) };
  }

  // ── AD-5 WINDOW ────────────────────────────────────────────────────────────
  // The ref has advanced; the checked-out working tree has not yet caught up. A
  // crash HERE is recoverable from {baseSha, candidateSha, currentTargetSha}
  // alone — see recoverCheckout. Publication state is NEVER inferred from
  // working-tree contents, which are ambiguous mid-checkout.
  opts?.afterRefAdvance?.();

  try {
    syncCheckout(t, candidateSha, renew);
  } catch (e) {
    // A checkout FAILURE (not a crash) after the ref advanced is the one thing a
    // publication must never leave behind: the ref carries the candidate while the
    // index and working tree still carry the base, so every LATER publication's
    // AD-3 pre-check sees the whole diff as tracked dirt and refuses — the target
    // is wedged, permanently, by a publication that reported nothing.
    //
    // So — WHILE WE STILL PROVABLY OWN THE WINDOW — we UNDO our own ref advance, by
    // CAS, and refuse. The CAS is what makes the undo precise: `update-ref <ref>
    // <base> <candidate>` only lands if the ref is STILL the candidate we just wrote
    // — i.e. only if we are undoing our own write and nobody else's. An external
    // writer that got in anyway fails the CAS, so we leave their commit alone and
    // report the publication as landed (the ref moved past us; recovery re-derives
    // the truth from the REF).
    //
    // The result is a target that is byte-for-byte where it started: nothing
    // published, nothing staged, nothing to clean up, and the NEXT publication is
    // not blocked. This is the AD-5 rule applied to a failure rather than a crash
    // — state is defined, idempotent, and derived from the three SHAs alone.
    //
    // THE ROLLBACK IS ITSELF A TARGET MUTATION, so it runs ONLY while ownership is
    // CURRENTLY PROVEN — renew?.() throws if the hold is gone, and it is called FOR
    // this rollback, immediately before it. A CAS is not a substitute for the mutex
    // here: once our lease lapsed, the attempt that TOOK the window may already have
    // AD-5-recovered index and worktree onto our candidate, and our CAS "undo" would
    // then still succeed against the ref — leaving ref=base with the tree at the
    // candidate, i.e. a dirty, divergent target that no later publication can pass
    // AD-3 against. Once a publisher discovers it no longer owns the mutex it
    // executes NO target-mutating command, not even an undo of its own write.
    //
    // What we leave behind instead is the state AD-5 is FOR: the ref carries the
    // candidate, the durable attempt still records {baseSha, candidateSha, target},
    // and whoever owns the mutex now converges the tree from those three facts.
    try {
      renew?.();
    } catch (lost) {
      throw new MutexLostMidPublishError(t.projectDir, baseSha, candidateSha, (lost as Error).message);
    }
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

/** The ref advance LANDED, the checkout did not, and the publisher can no longer
 *  prove it owns the publication mutex — so it stopped, with the target ref carrying
 *  the candidate and the checked-out tree still at the base.
 *
 *  This is NOT a wedged target and NOT a half-publication to clean up: it is the
 *  ordinary AD-5 window, reached by a lost lease rather than a crash. The durable
 *  attempt still records {baseSha, candidateSha, target}, so the publisher that owns
 *  the mutex NOW converges the tree from those three facts. The one thing this
 *  process may not do is touch the target — including rolling back its own advance,
 *  which would strand a target whose tree the new owner has already synchronized. */
export class MutexLostMidPublishError extends Error {
  readonly reason = "publication_mutex_lost" as const;
  /** The lost-hold error that caused this, kept as EVIDENCE and deliberately NOT
   *  interpolated into the message. That error is the pre-CAS story — its prose says
   *  "nothing was published by this attempt", which is true where it is thrown and a
   *  LIE here: the ref carries the candidate. A cause chain is not exempt from the
   *  rule that no operator surface may claim nothing landed when something did
   *  (FG-425 AC5), and this message is read straight onto the task row. */
  constructor(
    public readonly projectDir: string,
    public readonly baseSha: string,
    public readonly candidateSha: string,
    public readonly detail: string,
  ) {
    super(
      `stopped mid-publication on ${projectDir}: the target ref carries ${candidateSha.slice(0, 12)} — the CAS ` +
        `LANDED — but its checked-out tree could not be updated to it, and ownership of the publication window can ` +
        `no longer be proven. NO further target mutation was performed — not even a rollback of this attempt's own ` +
        `ref advance — because a publisher that lost the mutex may write nothing at all. The publication intent is ` +
        `durable; AD-5 recovery converges the target from {baseSha, candidateSha, currentTargetSha}.`,
    );
    this.name = "MutexLostMidPublishError";
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
function syncCheckout(t: LocalTarget, candidateSha: string, renew?: RenewHold): void {
  git(t.projectDir, ["read-tree", "-m", "-u", candidateSha], renew);
}

/** AD-5 recovery. Derived ONLY from the three SHAs — the working tree is never
 *  inspected to decide what happened. Idempotent and safe to re-run after a crash
 *  at any step. */
export type RecoveryOutcome =
  | { state: "not_published" }
  /** `superseded`: the ref has moved PAST our candidate — a later publication built
   *  on top of it. Our commit is in the target's history, so this attempt DID land;
   *  the checkout is NOT re-run, because the tree belongs to the newer publication
   *  and rewinding it to our candidate would un-publish work that came after. */
  | { state: "published"; publishedSha: string; checkoutError?: string; superseded?: boolean }
  | { state: "external_writer"; currentSha: string };

export function recoverCheckout(
  t: PublicationTarget,
  baseSha: string,
  candidateSha: string,
  renew?: RenewHold,
): RecoveryOutcome {
  const current = readTargetSha(t, renew);
  if (current === baseSha) return { state: "not_published" };
  if (current !== candidateSha) {
    // The ref is at neither SHA, and there are two utterly different reasons for
    // that. If our candidate is an ANCESTOR of where the ref now sits, our CAS
    // landed and a LATER publication simply built on top of it — our work is in the
    // target's history, and reporting "nothing was published" here would be a lie
    // that invites a retry of work that is already on the target. Only when the
    // candidate is NOT in that history did we genuinely publish nothing.
    //
    // Still derived from {baseSha, candidateSha, currentTargetSha} alone: ancestry
    // is a property of those SHAs, not of the working tree, which AD-5 never
    // inspects.
    //
    // `current` is a READ of the ref, and for a remote that read is one round trip
    // old by the time we ask about history. The disposition is therefore derived from
    // `observedSha` — the tip the ancestry check itself OBSERVED — never from the sha
    // we happened to read first. Terminalizing an attempt from an obsolete snapshot
    // of the target is the same lie as parking a publication that landed.
    const observed = candidateInTargetHistory(t, candidateSha, current, renew);
    if (observed.inHistory) {
      return {
        state: "published",
        publishedSha: candidateSha,
        superseded: observed.observedSha !== candidateSha,
      };
    }
    return { state: "external_writer", currentSha: observed.observedSha };
  }
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
      syncCheckout(t, candidateSha, renew);
    } catch (e) {
      return { state: "published", publishedSha: candidateSha, checkoutError: (e as Error).message };
    }
  }
  return { state: "published", publishedSha: candidateSha };
}

/** The ancestry answer AND the tip it was answered against: is the candidate in the
 *  target's history, as OBSERVED at `observedSha`? The caller classifies from
 *  `observedSha`, never from the sha it read before asking. */
type TargetAncestry = { inHistory: boolean; observedSha: string };

/** Is the candidate in the target's history — i.e. did our CAS/push land and a later
 *  publication simply build on top of it?
 *
 *  For a LOCAL target both SHAs are already in the repo, and the ref read IS the
 *  observation: nothing can move between the two under the mutex. For a REMOTE one the
 *  target's tip is not in the repo, so fetch the target ref into the pushing repo's
 *  object store first — a local-object write, never a mutation of the target. Refusing
 *  to ask the question of a remote is what made a superseded remote publication
 *  indistinguishable from one that never landed: recovery reported `external_writer`,
 *  parked the attempt as `publish_base_churn`, and told the operator nothing had been
 *  published while the candidate sat in the remote's history (FG-425 AC5).
 *
 *  The remote answer is derived from the tip THE FETCH BROUGHT BACK, re-resolved from
 *  FETCH_HEAD — not from the ls-remote sha the caller read a round trip earlier. A
 *  remote that moves in that window (a later publication, a force-update) would
 *  otherwise have recovery decide — and TERMINALIZE — from a target snapshot that was
 *  already obsolete when it was fetched. That the `current` OBJECT exists locally after
 *  the fetch is not the same question as "is the ref still there": a force-moved ref
 *  leaves that object perfectly readable and utterly stale.
 *
 *  The question can still be UNANSWERABLE — the fetch fails, the remote ref is gone,
 *  FETCH_HEAD does not resolve. Recovery then settles nothing and throws: it is
 *  idempotent and the next sweep re-reads the ref, which is the only honest disposition
 *  when "did it land?" has no answer yet. Guessing `external_writer` here is precisely
 *  the bug. */
function candidateInTargetHistory(
  t: PublicationTarget,
  candidateSha: string,
  current: string,
  renew?: RenewHold,
): TargetAncestry {
  if (t.kind === "local") {
    return { inHistory: isAncestor(t.projectDir, candidateSha, current, renew), observedSha: current };
  }

  renew?.();
  let tip: string;
  try {
    git(t.projectDir, ["fetch", "--quiet", t.remote, refOf(t)]);
    tip = git(t.projectDir, ["rev-parse", "FETCH_HEAD"], renew);
  } catch (e) {
    throw new RemoteAncestryUnknownError(t, candidateSha, current, (e as Error).message);
  }
  if (!/^[0-9a-f]{40}$/.test(tip)) {
    throw new RemoteAncestryUnknownError(
      t,
      candidateSha,
      current,
      `the fetched tip of ${refOf(t)} did not resolve (FETCH_HEAD = "${tip}")`,
    );
  }
  return { inHistory: isAncestor(t.projectDir, candidateSha, tip, renew), observedSha: tip };
}

/** Recovery could not fetch the remote target's history, so whether the candidate
 *  LANDED is unknown. Nothing is settled and nothing is retried — the attempt stays
 *  `publishing` and the next recovery pass asks again. */
export class RemoteAncestryUnknownError extends Error {
  readonly reason = "remote_ancestry_unknown" as const;
  constructor(
    public readonly target: RemoteTarget,
    public readonly candidateSha: string,
    public readonly currentSha: string,
    public readonly detail: string,
  ) {
    super(
      `recovery cannot yet tell whether ${candidateSha.slice(0, 12)} landed on ${targetDescriptor(target)}: the ` +
        `remote sits at ${currentSha.slice(0, 12)}, which is neither the validated base nor the candidate, and its ` +
        `history could not be read (${detail}). The candidate MAY be published — do NOT retry this work. The attempt ` +
        `stays \`publishing\`; recovery is idempotent and the next \`forge next\` (or \`forge publish recover\`) ` +
        `re-derives the truth once the remote is reachable.`,
    );
    this.name = "RemoteAncestryUnknownError";
  }
}

function publishRemote(
  t: RemoteTarget,
  baseSha: string,
  candidateSha: string,
  opts?: PublishOpts,
): PublishResult {
  // The ancestry proof already ran in publishToTarget — BEFORE this network
  // write, which is the whole point: no push may happen until the candidate is
  // proven to be a fast-forward of the validated base.
  //
  // The lease is EXPLICIT (<ref>:<baseSha>), never the implicit form. It is the
  // atomic stale-base guard and nothing more.
  opts?.renewHold?.();
  try {
    execFileSync(
      "git",
      [
        "push",
        `--force-with-lease=${refOf(t)}:${baseSha}`,
        t.remote,
        `${candidateSha}:${refOf(t)}`,
      ],
      {
        cwd: t.projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: WINDOW_GIT_TIMEOUT_MS,
      },
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
