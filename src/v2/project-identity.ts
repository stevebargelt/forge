// FG-425: canonical project identity — the ONE key the publication lane and the
// publication mutex are both keyed on.
//
// Salvaged from the abandoned branch fix/fg425-project-gate-locking@ce22024
// (projectIntegrationLockKey / describeWait). Everything else on that branch —
// the long integration lock and the whole gate process-supervision layer — is
// discarded: see learnings/decisions/serialized-integration-publisher.md.
//
// Two runs pointed at one repo through different spellings (symlink, trailing
// slash, relative path) must collapse to ONE identity, or they would each get
// their own lane and publish against each other's moving target. realpath is
// what collapses them.
//
// ── FG-693: THIS MODULE NO LONGER CANONICALIZES ANYTHING ───────────────────
//
// It is now a THIN PROJECTION over the one filesystem-identity contract in
// src/util/path-identity.ts. It owns exactly two things that are genuinely its
// own — the KEY DERIVATION and the operator-facing contention prose — and it asks
// the contract for identity itself. There is no realpath here, no try/catch
// around one, no `/private`, `/tmp` or `/var`, and no platform branch.
//
// WHAT WAS WRONG. The old implementation caught realpath's failure and fell back
// to `path.resolve`, so a spelling the filesystem REFUSED TO CONFIRM produced a
// lane key, a mutex key and a `canonicalDir` that were byte-indistinguishable
// from proven ones. Everything downstream — the FIFO lane, the publication mutex,
// the durable target descriptor AD-5 recovery rebuilds its target from — then
// coordinated on a LEXICAL GUESS while looking exactly like it was coordinating
// on identity. Two unproven spellings of one checkout get two guesses, so they
// get two lanes, both become head, both capture the same base and race the CAS:
// the moving-HEAD interleave the lane exists to prevent, arrived at by a
// mechanism that looked like it was working.
//
// ── THE THREE THINGS THAT REPLACE IT ───────────────────────────────────────
//
// 1. AN IDENTITY SAYS WHETHER IT IS PROVEN. `ProjectIdentity.proven` is false
//    exactly when the filesystem would not confirm the spelling. A guess is no
//    longer indistinguishable from a proven identity: it is labelled, in the
//    value itself, and every seam that DECIDES anything reads that label.
//
// 2. AN UNPROVEN KEY CANNOT IMPERSONATE A PROVEN ONE. The two keys are derived
//    in separate namespaces, so no lexical guess can ever hash onto a real
//    project's lane, mutex or attempt rows. Before, `/gone/checkout` and a live
//    checkout whose realpath happened to equal that lexical path produced the
//    SAME key — a guess reaching straight into another project's coordination.
//
// 3. AN UNPROVEN IDENTITY NEVER CLAIMS, NEVER ACTS, NEVER MUTATES. That is the
//    ACTING-class collapse of the contract's three-valued comparison, and it is
//    enforced at the seams that produce the arguments — requireProvenProjectDir
//    (publication-target: every target mutation and every AD-5 convergence) and
//    requireCanonicalProjectDir (publication-lane: taking a turn is a claim).
//    Both refuse by NAME (UnprovenProjectIdentityError), before any enqueue,
//    mutex acquisition or target write, so a refused publication has claimed
//    nothing and mutated nothing.
//
// WHY THE FALLBACK IS LABELLED RATHER THAN DELETED OUTRIGHT. One pre-FG-693
// consumer still calls this module for a TOLERANT lookup key —
// canonicalReceiptProjectDir (src/store/orchestrator-receipts.ts), whose FG-576
// contract is that a project directory that no longer resolves degrades to its
// as-written spelling on BOTH halves rather than throwing on an operator read.
// That consumer is migrated by FG-693's orchestrator-receipt step, which stops
// delegating here; when it does, `proven`, `unprovenProjectKeyFor` and the
// lexical branch below should be DELETED and this module made proven-only. The
// label is what keeps that residual honest and greppable in the meantime — it
// decides nothing on the publication path, because every seam there refuses it.
//
// DURABLE-KEY COMPATIBILITY (FG-693 AC6), stated because lane keys are durable
// rows: for a project directory that RESOLVES, this module derives exactly the
// key the old implementation derived — sha256 of the realpath — so every
// pre-change lane entry, publication attempt and mutex row remains reachable
// under the same key, and NOTHING is migrated, backfilled or rewritten. The only
// keys that change are the ones the old fallback minted for directories the
// filesystem would not confirm; those never named a proven tree, and they moved
// into a namespace where they can no longer collide with one.

import { createHash } from "node:crypto";
import { asIdentity, lexicalResolutionOf, type PathIdentityInput } from "../util/path-identity.js";

export type ProjectIdentity = {
  /** Stable hash of the identity. The lane key and the mutex key. */
  key: string;
  /** PROVEN: the physical directory, symlinks resolved. Operator-facing.
   *  UNPROVEN: the lexical resolution of the caller's spelling — a GUESS, kept
   *  only so the one legacy tolerant consumer keeps its FG-576 behaviour. It
   *  names no tree this process confirmed and may decide nothing. */
  canonicalDir: string;
  /** Did the FILESYSTEM confirm this directory? Read it before deciding anything
   *  — or, better, take one of the refusing helpers below, which read it for you
   *  and name what they refused. */
  proven: boolean;
};

/** The named refusal that replaces the lexical fallback wherever a decision is
 *  made. `action` names WHAT was refused, so an operator reads which claim did
 *  not happen rather than a bare path error. Thrown before anything is enqueued,
 *  claimed or mutated — a caller that sees this knows nothing was done. */
export class UnprovenProjectIdentityError extends Error {
  readonly reason = "unproven_project_identity" as const;
  constructor(
    public readonly projectDir: string,
    public readonly action: string,
    public readonly detail: string,
  ) {
    super(
      `refusing to ${action}: the project directory \`${projectDir}\` has no PROVEN filesystem identity — ` +
        `${detail}. The publication lane, the publication mutex and the durable target descriptor are all keyed ` +
        `on the PHYSICAL directory; keying them on an unproven spelling would let a second attempt on the same ` +
        `checkout take a lane of its own and publish against this one's moving target. Nothing was enqueued, ` +
        `claimed or mutated. Check the path and re-run.`,
    );
    this.name = "UnprovenProjectIdentityError";
  }
}

/** The lane/mutex key for a PROVEN physical directory. */
function provenProjectKeyFor(physicalDir: string): string {
  return createHash("sha256").update(physicalDir).digest("hex").slice(0, 16);
}

/** The key for a spelling the filesystem would not confirm — in its OWN
 *  namespace, so it can never hash onto a proven project's lane, mutex or
 *  attempts. A guess may be deterministic; it may not be mistaken for identity. */
function unprovenProjectKeyFor(asWritten: string): string {
  return createHash("sha256")
    .update(`unproven-project-identity ${lexicalResolutionOf(asWritten)}`)
    .digest("hex")
    .slice(0, 16);
}

/** ACTING-class admission to the publication path: the PROVEN physical directory,
 *  or a named refusal. Accepts ANY spelling — an alias, a trailing separator, a
 *  relative path, a symlinked parent — and collapses it, because collapsing
 *  aliases is the whole point; what it will not do is invent an answer the
 *  filesystem declined to give.
 *
 *  `action` is interpolated into the refusal ("refusing to <action>: …"). */
export function requireProvenProjectDir(projectDir: string, action: string): string {
  const id = asIdentity(projectDir);
  if (id.kind !== "resolved") {
    throw new UnprovenProjectIdentityError(
      id.asWritten,
      action,
      `the filesystem did not resolve it (${id.reason})`,
    );
  }
  return id.physical;
}

/** The same admission for a seam that is handed a directory ALREADY claimed to be
 *  canonical — the lane, which is keyed on the physical directory and names it to
 *  the operator in every contention line.
 *
 *  Stricter than requireProvenProjectDir by design: an alias reaching here means
 *  the caller derived its key from something other than proven identity, and the
 *  ACTING class refuses rather than claiming a lane on the strength of a spelling
 *  that disagrees with the key it was filed under. */
export function requireCanonicalProjectDir(dir: string, action: string): string {
  const physical = requireProvenProjectDir(dir, action);
  if (physical !== dir) {
    throw new UnprovenProjectIdentityError(
      dir,
      action,
      `it is an ALIAS of the physical directory \`${physical}\`, and this seam is keyed on the physical ` +
        `directory — canonicalize it through projectIdentity() before claiming`,
    );
  }
  return physical;
}

/** Canonicalize a projectDir to one identity.
 *
 *  Takes a raw spelling or an already-computed PathIdentity, so a caller holding
 *  one does not pay for a second realpath.
 *
 *  Returns `proven: false` — never a silent guess — when the filesystem will not
 *  confirm the path. Callers that DECIDE, CLAIM or ACT must not read
 *  `canonicalDir` off an unproven identity: take requireProvenProjectDir or
 *  requireCanonicalProjectDir instead, and let the refusal be named. */
export function projectIdentity(input: PathIdentityInput): ProjectIdentity {
  const id = asIdentity(input);
  return id.kind === "resolved"
    ? { key: provenProjectKeyFor(id.physical), canonicalDir: id.physical, proven: true }
    : {
        key: unprovenProjectKeyFor(id.asWritten),
        canonicalDir: lexicalResolutionOf(id.asWritten),
        proven: false,
      };
}

/** The operator-visible contention line, salvaged from the abandoned branch.
 *  Used for BOTH waits: the FIFO lane queue (long — spans another attempt's
 *  validation) and the short publication window (CAS + fast-forward only). It
 *  always names WHO holds, WHAT is being waited on, HOW LONG, and the next
 *  action — a waiting forge must never look like a hung one. */
export function describeWait(opts: {
  what: "lane" | "publication-window";
  canonicalDir: string;
  holderRunId?: string | undefined;
  holderAttemptId?: string | undefined;
  elapsedMs: number;
  position?: number | undefined;
}): string {
  const holder = opts.holderRunId ? `run ${opts.holderRunId}` : "another attempt";
  const attempt = opts.holderAttemptId ? ` (attempt ${opts.holderAttemptId})` : "";
  const where = opts.position !== undefined ? `, ${opts.position} ahead of us` : "";
  const subject =
    opts.what === "lane"
      ? "the integration lane"
      : "the publication window";
  return (
    `forge: waiting for ${subject} on ${opts.canonicalDir} — held by ${holder}${attempt}${where}, ` +
    `${Math.round(opts.elapsedMs / 1000)}s waited. ` +
    `Inspect with \`forge publish lane --project ${opts.canonicalDir}\`` +
    (opts.holderRunId ? ` or \`forge show ${opts.holderRunId}\`` : "") +
    `.`
  );
}

/** The same contention surface for a caller that must REFUSE rather than wait —
 *  an operator command that would otherwise mutate a target another attempt is
 *  currently inside. It names the holder for the same reason describeWait does:
 *  a refusal the operator cannot act on is indistinguishable from a wall. */
export function describeRefusal(opts: {
  what: "lane" | "publication-window";
  canonicalDir: string;
  action: string;
  holderRunId?: string | undefined;
  holderAttemptId?: string | undefined;
  /** What the operator should do about it — this is the actionable half. */
  remedy: string;
}): string {
  const holder = opts.holderRunId ? `run ${opts.holderRunId}` : "another attempt";
  const attempt = opts.holderAttemptId ? ` (attempt ${opts.holderAttemptId})` : "";
  const subject = opts.what === "lane" ? "the integration lane" : "the publication window";
  return (
    `forge: refusing to ${opts.action} — ${subject} on ${opts.canonicalDir} is HELD by ${holder}${attempt}. ` +
    `${opts.remedy} ` +
    `Inspect with \`forge publish lane --project ${opts.canonicalDir}\`` +
    (opts.holderRunId ? ` or \`forge show ${opts.holderRunId}\`` : "") +
    `.`
  );
}

/** FG-791: the operator-facing refusal when a LATER pipeline phase (verify, docs)
 *  would publish an artifact whose base is STALE — not an ancestor of the run's
 *  CURRENT candidate (the reviewed tip a settled evidence-led review advanced to).
 *
 *  A deliberate sibling of describeRefusal, and a DISTINCT refusal from the
 *  fast-forward ancestry proof in publication-target.ts. That proof asks "is the
 *  target still where this candidate was built on" and protects ref ancestry inside
 *  the CAS window; this one asks "was this candidate even built on the code the
 *  review shipped" and fires BEFORE the window. The FG-784 incident (fc881287)
 *  passed the fast-forward proof — the pre-review head WAS an ancestor of the target
 *  it merged onto — and still published a test authored against pre-fix semantics
 *  onto the reviewed branch, where it failed deterministically. The two guards catch
 *  different defects; neither subsumes the other.
 *
 *  It names the phase base, the current candidate and the remedy, because a refusal
 *  the operator cannot act on is indistinguishable from a wall. */
export function describeStaleBaseRefusal(opts: {
  canonicalDir: string;
  taskId: string;
  phaseBase: string;
  currentCandidate: string;
}): string {
  return (
    `forge: refusing to publish task ${opts.taskId} onto ${opts.canonicalDir} — its recorded base ` +
    `${opts.phaseBase.slice(0, 12)} is NOT an ancestor of the run's current candidate ` +
    `${opts.currentCandidate.slice(0, 12)} (the reviewed tip). This later phase validated a tree derived ` +
    `from the PRE-REVIEW integration head, so publishing it would merge a stale-based artifact onto the ` +
    `reviewed branch — code the review already replaced would be overwritten or contradicted by a test that ` +
    `never saw the fix (FG-791). Nothing was merged; the target ref is byte-for-byte unchanged. Re-drive this ` +
    `phase so its worktree bases on the current candidate ${opts.currentCandidate.slice(0, 12)}, then re-publish.`
  );
}

/** FG-791 (AC3): the refusal when a settled review candidate EXISTS but the
 *  publishing task carries NO recorded base. The stale-base guard cannot prove the
 *  phase's tree descends from the reviewed tip, so it must not fail open: a missing
 *  base under a settled candidate is exactly the unknown-provenance case the guard
 *  exists for. Distinct reason from describeStaleBaseRefusal — there the base is
 *  recorded and proven non-ancestor; here the base is absent and cannot be proven at
 *  all. (The pre-settlement / legacy no-candidate path stays a clean no-op — only a
 *  REAL current candidate makes an unrecorded base a refusal.) */
export function describeUnrecordedBaseRefusal(opts: {
  canonicalDir: string;
  taskId: string;
  currentCandidate: string;
}): string {
  return (
    `forge: refusing to publish task ${opts.taskId} onto ${opts.canonicalDir} — the run has a settled review ` +
    `candidate ${opts.currentCandidate.slice(0, 12)} (the reviewed tip) but this task has NO recorded base, so ` +
    `forge cannot prove its validated tree descends from the reviewed code rather than from a pre-review head. ` +
    `A missing base under a settled candidate is the unknown-provenance case the stale-base guard exists for; ` +
    `publishing it could overwrite the review's fix with a tree that never saw it (FG-791). Nothing was merged; ` +
    `the target ref is byte-for-byte unchanged. Re-drive this phase so its worktree records a base on the ` +
    `current candidate ${opts.currentCandidate.slice(0, 12)}, then re-publish.`
  );
}
