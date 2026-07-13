// FG-425: the serialized integration publisher.
//
// THE DEFECT IT REPLACES: validation used to run against the publish target
// AFTER the merge had already landed on it (four sites in runNext.ts). The target
// therefore sat merged-but-unvalidated for a full test-suite run (~10 min), and
// forge's run locking is per-runId — never per-projectDir — so two runs on one
// project could interleave merge/gate against a moving HEAD.
//
// THE DESIGN (the ticket's 10 steps):
//   1. capture the target's base SHA B
//   2. build candidate C in a FRESH, per-attempt integration worktree (AD-4)
//   3. merge the task branch(es) THERE — never into the target
//   4. validate C (gate / reds / review) against that worktree — never the target
//   5. take the SHORT publication mutex
//   6. confirm the target is still B (compare-and-swap)
//   7. fast-forward the target to the RECORDED C (AD-6)
//   8. if the target moved: rebuild on the new base and re-validate — ONCE (AD-1)
//   9. record {baseSha, candidateSha, publishedSha, target} durably
//  10. finalize idempotently
//
// The publication mutex is held ONLY across step 6-7 (+ the checked-out tree
// update). NEVER across validation. That is the whole point: an orphaned gate
// process can no longer touch the publish target, which is why this design
// deletes the process-supervision machinery outright (AD-7). See
// learnings/decisions/serialized-integration-publisher.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { newAttemptId } from "../util/ids.js";
import { PUBLICATIONS_DIR, publicationWorktreeDir } from "../util/paths.js";
import { logEvent } from "../store/events.js";
import {
  getPublicationAttempt,
  recordPublicationIntent,
  releasePublicationMutex,
  renewPublicationMutex,
  tryAcquirePublicationMutex,
  unfinishedPublications,
  updatePublicationAttempt,
  type ParkReason,
} from "../store/publications.js";
import { projectIdentity, describeWait } from "./project-identity.js";
import {
  awaitLaneTurn,
  LaneTakenOverError,
  leaveLane,
  preExtendLeaseForGate,
  renewLease,
  startLeaseHeartbeat,
  type LaneWaitOpts,
} from "./publication-lane.js";
import {
  CheckoutSyncError,
  DirtyPublishTargetError,
  NonFastForwardError,
  localTargetFor,
  parseTargetDescriptor,
  publishToTarget,
  readTargetSha,
  recoverCheckout,
  targetDescriptor,
  WINDOW_GIT_TIMEOUT_MS,
  type PublicationTarget,
  type RenewHold,
} from "./publication-target.js";
import { runIntegrationGate } from "./integration-gate.js";

/** AD-1: TWO full validations maximum — the initial attempt plus ONE rebuild
 *  after a moved base. A second moved-base result PARKS. Do NOT raise this: with
 *  a FIFO lane, forge-owned attempts cannot move each other's base, so repeated
 *  churn is a signal about an EXTERNAL writer to the target, not about
 *  forge-internal contention. Raising the bound would only spin harder against
 *  whoever else is pushing. */
export const MAX_REBUILDS = 1;

/** The mutex covers a CAS, a ref write and a checkout — seconds, not minutes. The
 *  TTL exists solely so a crashed holder cannot wedge the project; it is never a
 *  liveness judgement about another process (AD-7).
 *
 *  DERIVED, never a literal: it must comfortably exceed the ceiling on the longest
 *  SINGLE git op the window can block in, because that op is what the lease has to
 *  survive. The window is SYNCHRONOUS (execFileSync blocks the event loop), so no
 *  heartbeat can renew inside it — the holder renews BETWEEN ops instead, and the
 *  per-op ceiling is what makes renewing between ops sufficient. Get this pair
 *  wrong and a live publisher mid-`read-tree` can have its lease read as lapsed and
 *  a second attempt enter the tree with it: the CAS would still protect ref
 *  ancestry, but nothing would serialize the two working-tree updates. */
export const MUTEX_TTL_MS = WINDOW_GIT_TIMEOUT_MS + 60_000;
const MUTEX_POLL_MS = 250;

/** The mutex we held was taken over: our lease lapsed and another attempt entered
 *  the window. TERMINAL and NAMED (as LaneTakenOverError is for the lane) — the
 *  publisher FAILS CLOSED rather than keep writing to a working tree it no longer
 *  owns. Nothing that mutates the target runs after this throws: it can only fire
 *  before the CAS, or from inside the checkout, whose failure path rolls the ref
 *  advance back by CAS. */
export class PublicationMutexLostError extends Error {
  readonly reason = "publication_mutex_lost" as const;
  constructor(public readonly attemptId: string, canonicalDir: string) {
    super(
      `publication window: attempt ${attemptId} no longer holds the publication mutex on ${canonicalDir} — its ` +
        `lease lapsed and another attempt took the window. Refusing to write to the target any further; nothing ` +
        `was published by this attempt. A retry enqueues a new attempt (AD-7).`,
    );
    this.name = "PublicationMutexLostError";
  }
}

/** The hold the window's git ops renew against. Bounded op + renewal between ops
 *  is what lets the mutex expire safely at all — see MUTEX_TTL_MS. */
function windowHold(projectKey: string, attemptId: string, canonicalDir: string): RenewHold {
  return () => {
    if (!renewPublicationMutex(projectKey, attemptId, MUTEX_TTL_MS)) {
      throw new PublicationMutexLostError(attemptId, canonicalDir);
    }
  };
}

/** A branch to fold into the candidate. `worktreePath`, when present, is
 *  auto-committed first — the FG-352 no-discard contract: agent work that was
 *  left uncommitted in a worktree must never be silently dropped. */
export type CandidateSource = {
  branch: string;
  worktreePath?: string | undefined;
  label: string;
};

export type ValidationResult =
  | { ok: true; output?: string }
  | {
      ok: false;
      error: string;
      output?: string;
      status?: number | null;
      signal?: string | null;
      timedOut?: boolean;
    };

export type PublishOutcome =
  | {
      kind: "published";
      attemptId: string;
      baseSha: string;
      candidateSha: string;
      publishedSha: string;
      target: string;
      candidateWorktree: string;
      rebuilds: number;
      /** AD-5 recovery only: the publication IS durable (the ref carries the
       *  candidate), but the checked-out tree could not be brought up to it. */
      checkoutError?: string;
    }
  | { kind: "merge_failed"; attemptId: string; error: string; candidateWorktree: string }
  | {
      kind: "validation_failed";
      attemptId: string;
      candidateSha: string;
      candidateWorktree: string;
      error: string;
      status?: number | null;
      signal?: string | null;
      timedOut?: boolean;
    }
  | {
      kind: "parked";
      attemptId: string;
      reason: ParkReason;
      error: string;
      candidateWorktree?: string;
    }
  | { kind: "refused"; attemptId: string; error: string; candidateWorktree?: string };

export type PublishRequest = {
  runId: string;
  taskId: string;
  projectDir: string;
  sources: CandidateSource[];
  /** Defaults to the repo's checked-out branch — the only target wired in
   *  production today. The remote implementation exists and is tested. */
  target?: PublicationTarget;
  /** EXTRA validation, run against the candidate AFTER the integration gate passes
   *  — the reds and any review gate. It is part of the same validation set, so an
   *  AD-1 moved-base rebuild re-runs it too: a rebuild that re-ran only the gate
   *  would publish a tree no red ever saw.
   *
   *  The integration gate itself is NOT a caller's concern and is not overridable:
   *  the publisher always runs it, always against the candidate worktree. That is
   *  what makes "the gate never runs against the publish target" a property of this
   *  module rather than a convention every call site has to remember. */
  alsoValidate?: (candidateDir: string, candidateSha: string) => Promise<ValidationResult> | ValidationResult;
  lane?: LaneWaitOpts;
  /** Test-only: fires inside the AD-5 window (ref advanced, checkout not yet
   *  updated). Inert in production — nothing passes it. */
  afterRefAdvance?: () => void;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const IDENTITY = ["-c", "user.name=forge", "-c", "user.email=forge@local"];

/** AD-4: fresh and uniquely identified PER ATTEMPT (and per rebuild within it).
 *  CREATE-ONLY — an existing path at this identity is an invariant violation, not
 *  something to force-delete.
 *
 *  Deliberately NOT routed through the FG-353 helpers (createIntegrationWorktree /
 *  integrationBranchName): those are keyed on (runId, parentTaskId) and are
 *  PRUNE-THEN-CREATE, so an AD-1 rebuild through them would destroy the first
 *  attempt's tree — which is precisely the evidence AD-1 requires be PRESERVED on
 *  a churn park. They keep their current keying for the fan-out child-merge role. */
function createCandidateWorktree(
  projectDir: string,
  attemptId: string,
  rebuild: number,
  baseSha: string,
): { path: string; branch: string } {
  const path = publicationWorktreeDir(attemptId, rebuild);
  const branch = `forge/publish/${attemptId}/r${rebuild}`;
  if (existsSync(path)) {
    throw new Error(
      `publication worktree ${path} already exists — a publication attempt identity must be fresh (AD-4). ` +
        `This is an invariant violation, not a stale tree to reclaim.`,
    );
  }
  mkdirSync(PUBLICATIONS_DIR, { recursive: true });
  execFileSync("git", ["worktree", "add", path, "-b", branch, baseSha], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  return { path, branch };
}

/** Best-effort teardown. NEVER a precondition for a correct publication — a
 *  leaked worktree must not fail a publish that already landed. Eventual
 *  reclamation is FG-356's, via the worktree_path handle on the attempt record. */
function removeCandidateWorktree(projectDir: string, attemptId: string, rebuild: number): void {
  const path = publicationWorktreeDir(attemptId, rebuild);
  const branch = `forge/publish/${attemptId}/r${rebuild}`;
  try {
    execFileSync("git", ["worktree", "remove", "--force", path], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch { /* best-effort */ }
  try {
    execFileSync("git", ["branch", "-D", branch], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch { /* best-effort */ }
}

/** FG-352 no-discard: an agent is expected to commit on its task branch, but a
 *  worktree left dirty must not lose work. Mirrors mergeWorktreeBranch's safety
 *  net; a commit failure with changes PRESENT is fatal to the merge (the caller
 *  retains the worktree) rather than silently dropping the diff. */
function autoCommitSource(worktreePath: string, label: string): void {
  const status = git(worktreePath, ["status", "--porcelain"]);
  if (status.length === 0) return;
  execFileSync("git", ["add", "."], { cwd: worktreePath, stdio: "ignore" });
  execFileSync("git", [...IDENTITY, "commit", "-m", `forge: auto-commit ${label} output`], {
    cwd: worktreePath,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Fold one source branch into the candidate. Fast-forward when the candidate's
 *  base is an ancestor of the source (the ordinary case — the published SHA is
 *  then exactly the source tip, as before this ticket); a real merge commit when
 *  the base has MOVED, which is what "rebuild on the new base" means. */
function mergeSourceIntoCandidate(
  candidatePath: string,
  src: CandidateSource,
): { ok: true } | { ok: false; error: string } {
  try {
    if (src.worktreePath) autoCommitSource(src.worktreePath, src.label);
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
    return { ok: false, error: `auto-commit of ${src.label} output failed: ${stderr || String(e)}` };
  }
  try {
    execFileSync("git", [...IDENTITY, "merge", "--no-edit", src.branch], {
      cwd: candidatePath,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { ok: true };
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr ?? Buffer.alloc(0)).toString().trim();
    try {
      execFileSync("git", ["merge", "--abort"], { cwd: candidatePath, stdio: ["ignore", "ignore", "ignore"] });
    } catch { /* the merge may have failed before starting */ }
    return { ok: false, error: `merging ${src.branch} into the candidate failed: ${stderr || String(e)}` };
  }
}

/** Wait for the short publication mutex.
 *
 *  This is a BLOCKING SPAN THE LANE OWNER CAN SIT IN, so it renews the lane lease
 *  on every poll tick — exactly as awaitLaneTurn does. Renewing across validation
 *  but not across the mutex wait would leave a live holder able to lapse while
 *  blocked here and be marked abandoned by a later attempt: the same FIFO break
 *  the lease exists to prevent, moved one span later. Every span the owner can
 *  block in renews. */
async function acquireMutex(
  projectKey: string,
  attemptId: string,
  runId: string,
  canonicalDir: string,
  log: (line: string) => void,
): Promise<void> {
  const startedAt = Date.now();
  let lastReportMs = -Infinity;
  for (;;) {
    renewLease(attemptId);
    const got = tryAcquirePublicationMutex({ projectKey, attemptId, runId, ttlMs: MUTEX_TTL_MS });
    if (got.acquired) return;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastReportMs >= 10_000) {
      lastReportMs = elapsedMs;
      log(
        describeWait({
          what: "publication-window",
          canonicalDir,
          holderRunId: got.holder.runId,
          holderAttemptId: got.holder.attemptId,
          elapsedMs,
        }),
      );
    }
    await new Promise<void>((r) => setTimeout(r, MUTEX_POLL_MS));
  }
}

/** Validate a candidate in isolation, then publish that EXACT commit through a
 *  short compare-and-swap window. */
export async function publishIntegration(req: PublishRequest): Promise<PublishOutcome> {
  const identity = projectIdentity(req.projectDir);
  // The target is built from the CANONICAL dir so the descriptor recorded on the
  // attempt is the one AD-5 recovery can rebuild the target from — an attempt
  // recorded under one spelling of a path must not recover under another.
  const target = req.target ?? localTargetFor(identity.canonicalDir);
  const descriptor = targetDescriptor(target);
  /** THE validation set for a candidate: the integration gate, then whatever the
   *  caller folds in (reds, review). Called once per candidate INSIDE the rebuild
   *  loop, so an AD-1 rebuild re-runs ALL of it against the new candidateSha. */
  const validate = async (dir: string, sha: string): Promise<ValidationResult> => {
    const gate = runIntegrationGate(dir);
    if (!gate.ok) {
      return {
        ok: false,
        error: `${gate.error}\n${gate.output}`,
        output: gate.output,
        status: gate.status,
        signal: gate.signal,
        timedOut: gate.timedOut,
      };
    }
    if (!req.alsoValidate) return { ok: true, output: gate.output };
    return await req.alsoValidate(dir, sha);
  };
  const log = req.lane?.log ?? ((line: string) => console.log(line));

  // AD-5: publication INTENT is durably recorded BEFORE any target mutation, and
  // the durable FIFO enqueue key is assigned HERE — at record time, before any
  // contention. attemptId is minted now and is the identity everything downstream
  // (worktree, branch, lane entry, recovery) is keyed on.
  const attemptId = newAttemptId();
  recordPublicationIntent({
    attemptId,
    projectKey: identity.key,
    canonicalDir: identity.canonicalDir,
    runId: req.runId,
    taskId: req.taskId,
    target: descriptor,
    leaseTtlMs: 90_000,
  });
  logEvent("publication.requested", {
    runId: req.runId,
    taskId: req.taskId,
    payload: { attemptId, target: descriptor, project: identity.canonicalDir },
  });

  try {
    await awaitLaneTurn(attemptId, identity.canonicalDir, req.lane);

    for (let rebuild = 0; ; rebuild++) {
      // 1. Capture the base. Everything below is validated against THIS SHA.
      const baseSha = readTargetSha(target);
      updatePublicationAttempt(attemptId, { baseSha, state: "building", rebuildCount: rebuild });

      // 2. A FRESH worktree per attempt AND per rebuild (AD-4).
      const candidate = createCandidateWorktree(req.projectDir, attemptId, rebuild, baseSha);
      updatePublicationAttempt(attemptId, { worktreePath: candidate.path });

      // 3. Merge the sources THERE — never into the target.
      for (const src of req.sources) {
        const merged = mergeSourceIntoCandidate(candidate.path, src);
        if (!merged.ok) {
          updatePublicationAttempt(attemptId, { state: "failed" });
          logEvent("publication.merge_failed", {
            runId: req.runId,
            taskId: req.taskId,
            payload: { attemptId, branch: src.branch, error: merged.error },
          });
          return { kind: "merge_failed", attemptId, error: merged.error, candidateWorktree: candidate.path };
        }
      }

      const candidateSha = git(candidate.path, ["rev-parse", "HEAD"]);
      updatePublicationAttempt(attemptId, { candidateSha, state: "validating" });

      // 4. Validate the EXACT candidate, in its own worktree. The publication
      //    mutex is NOT held here — this is the span that used to run against the
      //    publish target. The LANE turn deliberately DOES span it (AD-2:
      //    candidate integration, final validation and publication are ordered);
      //    only the MUTEX is short.
      //
      //    `validate` is the FULL validation set for this candidate — the
      //    integration gate AND the reds AND any review gate (runNext supplies
      //    them). It is called once per candidate, INSIDE the rebuild loop, so an
      //    AD-1 rebuild on a moved base re-runs ALL of it against the NEW
      //    candidateSha. A rebuild that re-ran only the gate would publish a tree
      //    the reds never saw.
      //
      //    Both lease mechanisms, because validation is both kinds of span: a
      //    heartbeat for the async part (reds are containers), a pre-extension for
      //    the synchronous gate, inside which no timer can fire.
      const heartbeat = startLeaseHeartbeat(attemptId);
      preExtendLeaseForGate(attemptId);
      let validation: ValidationResult;
      try {
        validation = await validate(candidate.path, candidateSha);
      } finally {
        heartbeat.stop();
        renewLease(attemptId);
      }

      if (!validation.ok) {
        updatePublicationAttempt(attemptId, { state: "failed" });
        logEvent("publication.validation_failed", {
          runId: req.runId,
          taskId: req.taskId,
          payload: { attemptId, candidateSha, error: validation.error },
        });
        return {
          kind: "validation_failed",
          attemptId,
          candidateSha,
          candidateWorktree: candidate.path,
          error: validation.error,
          ...(validation.status !== undefined ? { status: validation.status } : {}),
          ...(validation.signal !== undefined ? { signal: validation.signal } : {}),
          ...(validation.timedOut !== undefined ? { timedOut: validation.timedOut } : {}),
        };
      }

      updatePublicationAttempt(attemptId, { state: "publishing" });

      // 5-7. The SHORT window: mutex → CAS → fast-forward → checkout update.
      await acquireMutex(identity.key, attemptId, req.runId, identity.canonicalDir, log);
      let moved: { currentSha: string } | undefined;
      try {
        const published = publishToTarget(target, baseSha, candidateSha, {
          renewHold: windowHold(identity.key, attemptId, identity.canonicalDir),
          ...(req.afterRefAdvance ? { afterRefAdvance: req.afterRefAdvance } : {}),
        });
        if (published.ok) {
          // AD-6: publishedSha IS the recorded candidateSha. publishToTarget CAS'd
          // that exact SHA onto the ref (or failed); it is never re-derived by
          // reading the target back, because a readback races every external
          // writer — and losing that race would turn a publication that ACTUALLY
          // LANDED into a churn park claiming nothing was published. The AC's proof
          // (publishedSha === candidateSha) is an assertion here, not a lookup.
          const publishedSha = published.publishedSha;
          if (publishedSha !== candidateSha) {
            throw new Error(
              `publication invariant violated: published ${publishedSha} but validated ${candidateSha} (AD-6)`,
            );
          }
          updatePublicationAttempt(attemptId, { publishedSha, state: "published" });
          logEvent("publication.published", {
            runId: req.runId,
            taskId: req.taskId,
            payload: {
              attemptId,
              target: descriptor,
              baseSha,
              candidateSha,
              publishedSha: published.publishedSha,
              rebuilds: rebuild,
            },
          });
          return {
            kind: "published",
            attemptId,
            baseSha,
            candidateSha,
            publishedSha: published.publishedSha,
            target: descriptor,
            candidateWorktree: candidate.path,
            rebuilds: rebuild,
          };
        }
        moved = { currentSha: published.currentSha };
      } catch (e) {
        if (e instanceof DirtyPublishTargetError) {
          // AD-3: refused BEFORE any mutation. The operator's dirty state is
          // untouched, and forge will never touch it.
          return park(attemptId, req, "dirty_publish_target", e.message, candidate.path);
        }
        if (
          e instanceof NonFastForwardError ||
          e instanceof CheckoutSyncError ||
          e instanceof PublicationMutexLostError
        ) {
          // CheckoutSyncError already rolled the ref back by CAS: the target is
          // byte-for-byte where it started, so this is a refusal like any other
          // and it leaves nothing behind to block the next publication.
          //
          // PublicationMutexLostError is the same shape — it fires only BEFORE the
          // CAS (a lost hold inside the checkout surfaces as CheckoutSyncError,
          // rolled back), so nothing of ours is on the target either way.
          updatePublicationAttempt(attemptId, { state: "failed" });
          logEvent("publication.refused", {
            runId: req.runId,
            taskId: req.taskId,
            payload: { attemptId, candidateSha, baseSha, reason: e.reason, error: e.message },
          });
          return { kind: "refused", attemptId, error: e.message, candidateWorktree: candidate.path };
        }
        throw e;
      } finally {
        releasePublicationMutex(identity.key, attemptId);
      }

      // 8. The base MOVED. Rebuild on the new base and re-validate — but only
      //    once (AD-1). Never publish the merge we already built: it was
      //    validated against a base that no longer exists on the target.
      logEvent("publication.base_moved", {
        runId: req.runId,
        taskId: req.taskId,
        payload: { attemptId, expectedBase: baseSha, foundSha: moved.currentSha, rebuild },
      });
      if (rebuild >= MAX_REBUILDS) {
        return park(
          attemptId,
          req,
          "publish_base_churn",
          `the publish target ${descriptor} moved off the validated base twice ` +
            `(expected ${baseSha.slice(0, 12)}, found ${moved.currentSha.slice(0, 12)}). ` +
            `Forge-owned attempts are FIFO-ordered and cannot move each other's base, so this means an EXTERNAL ` +
            `writer is pushing to the target mid-run. Parking with evidence preserved rather than publishing an ` +
            `unvalidated merge. Do not respond by raising the rebuild bound — find the other writer.`,
          candidate.path,
        );
      }
    }
  } catch (e) {
    if (e instanceof LaneTakenOverError) {
      // We are alive, but a later attempt found our lease lapsed and stepped past
      // us. That is TERMINAL — we can never be head again — and it must be a NAMED
      // outcome, not a TypeError and not an infinite wait. Nothing was published:
      // every target mutation happens under the mutex + CAS, downstream of the
      // lane turn we no longer hold. AD-7: a retry enqueues a NEW attempt with a
      // fresh worktree; nothing is signalled or reaped.
      return park(attemptId, req, "lane_taken_over", e.message);
    }
    throw e;
  } finally {
    // The lane entry reaches a terminal state on every path — pass, fail, park,
    // or throw. A CRASHED owner never gets here; its entry is instead skipped on
    // expiry by the next attempt's tick, which is what keeps the lane unwedgeable.
    leaveLane(attemptId, "done");
  }
}

function park(
  attemptId: string,
  req: PublishRequest,
  reason: ParkReason,
  error: string,
  candidateWorktree?: string,
): PublishOutcome {
  updatePublicationAttempt(attemptId, { state: "parked", parkReason: reason });
  logEvent("publication.parked", {
    runId: req.runId,
    taskId: req.taskId,
    payload: { attemptId, reason, error },
  });
  // Evidence (the candidate worktrees) is deliberately NOT cleaned up here.
  return { kind: "parked", attemptId, reason, error, ...(candidateWorktree ? { candidateWorktree } : {}) };
}

/** AD-5 recovery, derived from {baseSha, candidateSha, currentTargetSha} ALONE.
 *  The working tree is never inspected — mid-checkout contents are ambiguous, and
 *  that ambiguity is exactly why the rule exists.
 *
 *    target at baseSha       → nothing published; clean to retry or abandon
 *    target at candidateSha  → the ref advanced; only the checkout update may be
 *                              outstanding, so re-run it (idempotent)
 *    target at neither       → an external writer; the publish_base_churn path
 *
 *  The target is rebuilt from the descriptor RECORDED on the attempt, never
 *  re-derived from the repo's CURRENT HEAD. AD-5 says recovery reads the recorded
 *  {baseSha, candidateSha, currentTargetSha} and the recorded TARGET — and it means
 *  the ref, not the ambient one: an operator who checked out another branch (or
 *  detached HEAD) after the crash would otherwise have recovery inspect the wrong
 *  ref, park a publication that actually landed, or throw outright.
 *
 *  Idempotent and safe to re-run after a crash at ANY step. */
export function recoverPublicationAttempt(
  attemptId: string,
  /** The sweep's hold on the publication window. Recovery RE-RUNS the checkout, so
   *  it is a target working-tree write and carries the same bounded-op + renewal
   *  contract a publish does. `forge publish recover` (an operator running it by
   *  hand, with no window held) passes nothing. */
  renew?: RenewHold,
): PublishOutcome | { kind: "unknown_attempt" } {
  const attempt = getPublicationAttempt(attemptId);
  if (!attempt) return { kind: "unknown_attempt" };
  if (!attempt.baseSha || !attempt.candidateSha) {
    return { kind: "refused", attemptId, error: "attempt crashed before a candidate existed — nothing was published" };
  }
  const recorded = parseTargetDescriptor(attempt.target);
  // The remote descriptor names the remote and branch but not the repo the push
  // runs from; that is the attempt's canonical dir.
  const target: PublicationTarget =
    recorded.kind === "remote" ? { ...recorded, projectDir: attempt.canonicalDir } : recorded;

  const outcome = recoverCheckout(target, attempt.baseSha, attempt.candidateSha, renew);
  if (outcome.state === "published") {
    // Converge the record on the truth the REF tells us. Idempotent: re-running
    // this never discards a correct publication.
    updatePublicationAttempt(attemptId, { publishedSha: outcome.publishedSha, state: "published" });
    return {
      kind: "published",
      attemptId,
      baseSha: attempt.baseSha,
      candidateSha: attempt.candidateSha,
      publishedSha: outcome.publishedSha,
      target: attempt.target,
      candidateWorktree: attempt.worktreePath ?? "",
      rebuilds: attempt.rebuildCount,
      ...(outcome.checkoutError ? { checkoutError: outcome.checkoutError } : {}),
    };
  }
  if (outcome.state === "external_writer") {
    updatePublicationAttempt(attemptId, { state: "parked", parkReason: "publish_base_churn" });
    return {
      kind: "parked",
      attemptId,
      reason: "publish_base_churn",
      error:
        `recovery: the target is at ${outcome.currentSha.slice(0, 12)}, which is neither the validated base nor the ` +
        `candidate — an external writer moved it. Nothing from this attempt was published.`,
      ...(attempt.worktreePath ? { candidateWorktree: attempt.worktreePath } : {}),
    };
  }
  if (attempt.state !== "abandoned") updatePublicationAttempt(attemptId, { state: "abandoned" });
  return { kind: "refused", attemptId, error: "recovery: nothing was published; the attempt is abandoned (AD-7)" };
}

/** AD-5 recovery ON THE RUN PATH. Called before forge publishes anything against
 *  a project, so a crash inside a previous attempt's publication window is
 *  converged AUTOMATICALLY rather than sitting there until a human happens to
 *  notice and type `forge publish recover`.
 *
 *  `publishing` is the only non-terminal state in which the target may already
 *  have been mutated — every earlier state is upstream of the CAS. Leaving one
 *  unresolved leaves the target advanced, the record unfinished, and (before the
 *  rollback in publishLocal) the next publication blocked. A defined recovery that
 *  nothing ever invokes is not a defined recovery.
 *
 *  Idempotent, and never throws: a recovery failure must not take down a run that
 *  has not published anything yet. */
export function recoverUnfinishedPublications(projectDir: string, runId?: string): void {
  const { key } = projectIdentity(projectDir);
  const pending = unfinishedPublications(key);
  if (pending.length === 0) return;

  // Recovery re-runs the checkout, so it is a WRITE to the target's working tree —
  // exactly what the publication mutex serializes. Take it, or a sweep could run a
  // checkout underneath a DIFFERENT attempt that is legitimately inside its window
  // right now. If someone else holds it, they are mid-publication: leave the
  // recovery to the next wave rather than queue behind them, since nothing here is
  // urgent and the attempts we would converge are already abandoned.
  const recoverer = `recover-${newAttemptId()}`;
  if (!tryAcquirePublicationMutex({ projectKey: key, attemptId: recoverer, runId: runId ?? "recover", ttlMs: MUTEX_TTL_MS }).acquired) {
    return;
  }
  try {
    for (const attempt of pending) {
      let outcome: PublishOutcome | { kind: "unknown_attempt" };
      try {
        outcome = recoverPublicationAttempt(attempt.attemptId, windowHold(key, recoverer, projectDir));
      } catch (e) {
        logEvent("publication.recovered", {
          ...(runId ? { runId } : {}),
          taskId: attempt.taskId,
          payload: { attemptId: attempt.attemptId, outcome: "recovery_failed", error: (e as Error).message },
        });
        continue;
      }
      logEvent("publication.recovered", {
        ...(runId ? { runId } : {}),
        taskId: attempt.taskId,
        payload: {
          attemptId: attempt.attemptId,
          outcome: outcome.kind,
          target: attempt.target,
          ...(outcome.kind === "published" ? { publishedSha: outcome.publishedSha } : {}),
          ...(outcome.kind === "published" && outcome.checkoutError
            ? { checkoutError: outcome.checkoutError }
            : {}),
          ...(outcome.kind === "parked" ? { reason: outcome.reason } : {}),
        },
      });
    }
  } finally {
    releasePublicationMutex(key, recoverer);
  }
}

/** Idempotent finalize. Reclaims the attempt's candidate worktrees ONLY once the
 *  publication is durable — a failed or PARKED attempt keeps its trees, because
 *  they are the evidence AD-1 requires be preserved. Never throws: cleanup is not
 *  a correctness step, and a leaked worktree must never fail a correct publish. */
export function finalizePublication(projectDir: string, attemptId: string): void {
  const attempt = getPublicationAttempt(attemptId);
  if (!attempt || attempt.state !== "published") return;
  for (let rebuild = 0; rebuild <= attempt.rebuildCount; rebuild++) {
    removeCandidateWorktree(projectDir, attemptId, rebuild);
  }
}
