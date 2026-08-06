// FG-591 (step 7 / D4): THE CLAIM EXECUTION LIFECYCLE — launch, adopt, heartbeat,
// observe, release, cancel.
//
// FG-610 shipped the RESERVATION (queue_claims: claim, lease, fence, takeover,
// launch stamp, release) and deliberately shipped no executor. This module is the
// executor, and it is written around one distinction the whole design rests on:
//
//   queue_claims is authoritative for the RESERVATION.
//   the run / launch record is authoritative for the EXECUTION.
//
// They are read SEPARATELY and joined IN MEMORY — never in one SQL statement — so
// neither is ever derived from the other. A claim can exist with nothing running
// (the window between the grant and the launch); a container can still be running
// under a claim whose lease has lapsed. Collapsing the two is how a reservation gets
// released while its container still writes to a repo, which re-admits the ticket to
// the scan and lets a second dispatcher launch it. That duplicate execution is the
// exact defect the claim primitive exists to prevent.
//
// ─── AN OUTCOME DESCRIBES THE RESERVATION, NEVER THE WORK ────────────────────
// RELEASE_OUTCOMES below is THE vocabulary FG-591 owns, beside FG-610's
// TAKEOVER_OUTCOME. queue_claims.outcome carries no CHECK — FG-585: SQLite cannot
// widen one on the additive-only path — so the closure is enforced HERE, by a named
// refusal, and pinned by a test over the exported set.
//
// `launch_failed` is deliberately NOT `failed`. "The reservation ended because no
// container was ever started" and "the work ran and failed" are different
// operational facts, and conflating them makes a never-launched ticket read on the
// board exactly like a ticket whose agents failed.
//
// ─── DEQUEUE IS NOT CANCEL (D4) ──────────────────────────────────────────────
// No dequeue, unrank or defer path reaches releaseClaim, here or anywhere. Those are
// PLANNING mutations over queue membership and rank; a live claim is an EXECUTION
// reservation over a container that may still be running. Releasing one from a
// planning verb would re-admit a running ticket to the scan.
//
// Cancellation is therefore a separate, explicitly named act with an ASYMMETRIC
// order: stop the work FIRST, then release the reservation, and let the release be
// issued by the LEASE OWNER (releaseClaim is owner+generation+lease fenced, so it
// could not be issued by anyone else even if a caller tried — it would return null,
// which reads like success and is a worse failure than a refusal).
//
// ─── THE STAMP, AND THE WINDOW THIS MODULE CANNOT CLOSE ──────────────────────
// recordClaimLaunch is stamped as the FIRST act after startLaunch returns and before
// anything else — before the launch observation, before any wait. It cannot be
// stamped strictly BEFORE the physical launch, because startLaunch MINTS the launch
// id itself (src/v2/launch.ts: `launch-${name}-${rand}`) and returns only once the
// tmux pane already holds the command. That is the same window the campaign
// drive-item launcher accepts (executor.ts: startLaunch → recordLaunchStart →
// recordDriveItemLaunchLinkage), and it is named here rather than left to be
// discovered.
//
// It is MITIGATED rather than dismissed: `recordLaunchStart` records the SUBMITTER's
// declared ticket association on the launch row, so a successor that takes over a
// claim carrying NO launch stamp can DISCOVER an orphaned container by that durable
// association (discoverOrphanLaunch below) instead of concluding "nothing was ever
// started" and launching a second one. Nothing here parses a launch NAME, ARGV or
// LOG TEXT for that — FG-492 quarantined exactly that inference and it authorizes
// nothing.
//
// ─── WHAT THIS MODULE NEVER WRITES ───────────────────────────────────────────
// tickets.status, blocker_evidence, priority_rank, queue_membership. Nothing here
// stores `blocked` or `in_progress` — both stay DERIVED on every read (queue.ts) —
// and nothing here reorders the operator's queue. A launch that could not resolve a
// checkout is a fact about the DISPATCHER, not a blocker on the ticket.
//
// ─── THE CLOCK RULE ──────────────────────────────────────────────────────────
// Every instant compared or written here is the STORE's own clock (storeNowMs), never
// a process clock, so two forge processes with skewed clocks cannot disagree about
// whether a lease is live or a claim is old enough to retire.

import { existsSync } from "node:fs";
import { performCancel, type CancelOutcome } from "../cli/commands/cancel.js";
import { getDb } from "../store/db.js";
import { storeNowMs } from "../store/publications.js";
import { QueueRefusal } from "../store/queue.js";
import { getTicket } from "../store/tickets.js";
import { getRun } from "../store/runs.js";
import {
  getClaim,
  liveClaims,
  heartbeatClaim,
  recordClaimLaunch,
  releaseClaim,
  type QueueClaim,
} from "../store/queue-claims.js";
import { getDispatcherPolicy, type DispatcherPolicy } from "../store/dispatcher-policy.js";
import { recordEvaluation, type DispatcherEvaluation } from "../store/dispatcher-evidence.js";
import {
  getLaunchObservation,
  promoteLaunchObservations as promoteLaunchObservationsReal,
  recordLaunchStart as recordLaunchStartReal,
  type LaunchObservation,
} from "../store/launch-observations.js";
import { removeLaunch as removeLaunchReal, startLaunch as startLaunchReal, type LaunchMeta } from "../v2/launch.js";
import { acquireRunLock, releaseRunLock } from "../util/run-lock.js";
import { FORGE_HOME, DB_PATH } from "../util/paths.js";

// ─── THE RELEASE VOCABULARY FG-591 OWNS ──────────────────────────────────────

/**
 * Every value describes the RESERVATION, never the work:
 *   completed     — the execution this reservation covered reached a clean terminal.
 *   failed        — it reached a failed terminal.
 *   cancelled     — an operator stopped the work and the reservation was retired after it.
 *   launch_failed — the reservation ended with NO container ever started (an
 *                   unresolvable checkout/workflow, a tmux failure, a launch that
 *                   produced no run). Distinct from `failed` on purpose.
 *   superseded    — the reservation no longer describes anything: nothing was ever
 *                   launched under it and the work it reserved is gone or is
 *                   executing outside the ledger.
 *
 * FG-610's TAKEOVER_OUTCOME sits BESIDE this set — it is stamped by the primitive on
 * a predecessor it retires, and is deliberately not re-exported or re-spelled here.
 */
export const RELEASE_OUTCOMES = ["completed", "failed", "cancelled", "launch_failed", "superseded"] as const;

export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];

const RELEASE_OUTCOME_SET = new Set<string>(RELEASE_OUTCOMES);

export function isReleaseOutcome(s: string): s is ReleaseOutcome {
  return RELEASE_OUTCOME_SET.has(s);
}

/** The ONE place a release is issued in this module. Every caller goes through it,
 *  so the vocabulary closure is structural rather than remembered: an out-of-set
 *  outcome refuses BY NAME and writes nothing.
 *
 *  Owner+generation are read from the CLAIM ROW, never supplied by a caller: the
 *  release must be issued by the identity that holds the lease, and letting a caller
 *  name one would make an unfenced release expressible. */
function releaseReservation(claim: QueueClaim, outcome: ReleaseOutcome): QueueClaim | null {
  if (!isReleaseOutcome(outcome)) {
    throw new QueueRefusal(
      `forge: queue claim-release refuses — '${String(outcome)}' is not one of the ` +
        `${RELEASE_OUTCOMES.length} release outcomes FG-591 owns (${RELEASE_OUTCOMES.join(" | ")}). ` +
        `queue_claims.outcome carries no CHECK (FG-585), so an unrecognised outcome would persist and ` +
        `then read as an unexplained end-of-reservation on every surface. Nothing was written.`,
      "claim-release",
      claim.ticketId,
    );
  }
  return releaseClaim({
    projectKey: claim.projectKey,
    claimId: claim.id,
    owner: claim.owner,
    generation: claim.generation,
    outcome,
  });
}

// ─── the seams ───────────────────────────────────────────────────────────────

/** The subprocess/tmux boundary — the ONE seam a test may substitute, the same shape
 *  campaign/executor.ts uses. Production wires the real article, so the argv, the
 *  ownership transfer and the durable stamp ordering under test are the production
 *  ones. */
export type ExecutionSeams = {
  startLaunch?: (argv: string[], opts: { name: string; cwd: string }) => LaunchMeta;
  recordLaunchStart?: (meta: LaunchMeta, association: { ticketId: string }) => boolean;
  removeLaunch?: (id: string, opts?: { force?: boolean }) => void;
  promoteLaunchObservations?: () => number;
  /** The existing `forge cancel` seam. Defaults to the production path: steal the run
   *  lock (cancel is authoritative — AWN-2), performCancel, release the lock. */
  cancelWork?: (target: { runId: string; abandonRun: boolean }) => CancelOutcome;
};

function seamStartLaunch(seams: ExecutionSeams): (argv: string[], opts: { name: string; cwd: string }) => LaunchMeta {
  return seams.startLaunch ?? ((argv, opts) => startLaunchReal(argv, { name: opts.name, cwd: opts.cwd }));
}

function seamRecordLaunchStart(seams: ExecutionSeams): (meta: LaunchMeta, association: { ticketId: string }) => boolean {
  return seams.recordLaunchStart ?? ((meta, association) => recordLaunchStartReal(meta, association));
}

function seamRemoveLaunch(seams: ExecutionSeams): (id: string, opts?: { force?: boolean }) => void {
  return seams.removeLaunch ?? ((id, opts) => removeLaunchReal(id, opts ?? {}));
}

function seamPromote(seams: ExecutionSeams): () => number {
  return seams.promoteLaunchObservations ?? (() => promoteLaunchObservationsReal());
}

function defaultCancelWork(target: { runId: string; abandonRun: boolean }): CancelOutcome {
  // AWN-2: cancel STEALS the run lock so it interrupts a running next/gate/retry
  // rather than waiting behind it — exactly what src/cli/commands/cancel.ts does.
  acquireRunLock(target.runId, "queue-cancel", { steal: true });
  try {
    return performCancel(target.runId, { abandonRun: target.abandonRun });
  } finally {
    releaseRunLock(target.runId);
  }
}

function seamCancelWork(seams: ExecutionSeams): (target: { runId: string; abandonRun: boolean }) => CancelOutcome {
  return seams.cancelWork ?? defaultCancelWork;
}

// ─── resolving the launch target ─────────────────────────────────────────────

export type DispatchTargetRefusalKind =
  | "no_ticket"
  | "no_checkout"
  | "ambiguous_checkout"
  | "missing_checkout"
  | "no_workflow";

export type DispatchTargetRefusal = {
  kind: DispatchTargetRefusalKind;
  message: string;
};

export type DispatchTarget = {
  projectKey: string;
  ticketId: string;
  title: string;
  workflow: string;
  projectDir: string;
};

export type ResolveTargetResult = { ok: true; target: DispatchTarget } | { ok: false; refusal: DispatchTargetRefusal };

/** The project's known checkout directories, out of durable rows only.
 *
 *  There is no project_key → directory column anywhere in this store: project_identity
 *  keys on repository EVIDENCE (a remote url / git-common-dir), not a path. So the
 *  checkout is read from the two places the store has actually observed one —
 *  `tickets.imported_from` (the canonical source directory the ticket was last
 *  imported from) and the `runs.project_dir` of runs that carry dispatch evidence for
 *  this project's tickets. That is the SAME pair compatibility.ts reads for its
 *  foreign-execution narrowing, deliberately, rather than a second derivation. */
function observedCheckouts(projectKey: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT r.project_dir AS dir
         FROM ticket_dispatch_evidence e
         JOIN tasks t ON t.id = e.task_id
         JOIN runs r ON r.id = t.run_id
        WHERE e.project_key = ? AND r.project_dir IS NOT NULL AND r.project_dir <> ''
        UNION
       SELECT DISTINCT imported_from AS dir FROM tickets
        WHERE project_key = ? AND imported_from IS NOT NULL AND imported_from <> ''
        ORDER BY dir ASC`,
    )
    .all(projectKey, projectKey) as { dir: string }[];
  return rows.map((r) => r.dir);
}

/**
 * Resolve WHERE and WHAT a claimed ticket launches: the project checkout, the
 * workflow (the campaign planner's precedent — `feature` by default, overridable
 * host-wide or per project in dispatcher_policy) and the run title.
 *
 * EVERY failure is a NAMED refusal, never a silent no-op. An unresolvable launch
 * target with nothing said about it is precisely the "nothing started and nothing
 * said why" failure this ticket exists to close, and launchClaimedTicket RECORDS the
 * refusal (recordTargetRefusal) rather than returning quietly.
 *
 * AMBIGUITY REFUSES. Two observed checkouts for one project_key is the linked-worktree
 * shape, and picking one would run the ticket's work in a directory the operator did
 * not choose. The refusal names both and the caller supplies `projectDir` explicitly.
 */
export function resolveDispatchTarget(input: {
  projectKey: string;
  ticketId: string;
  /** An explicit checkout, which always wins — the operator's answer to an ambiguous
   *  or unobserved project. */
  projectDir?: string | undefined;
  /** An explicit workflow, overriding the policy default for this one dispatch. */
  workflow?: string | undefined;
}): ResolveTargetResult {
  const { projectKey, ticketId } = input;
  const ticket = getTicket(projectKey, ticketId);
  if (!ticket) {
    return {
      ok: false,
      refusal: {
        kind: "no_ticket",
        message:
          `no ticket '${ticketId}' exists in project '${projectKey}', so there is no title to launch a run ` +
          `with and no work to launch. The reservation is retired rather than launched.`,
      },
    };
  }

  const policy = getDispatcherPolicy(projectKey);
  const workflow = (input.workflow ?? policy.defaultWorkflow ?? "").trim();
  if (workflow.length === 0) {
    return {
      ok: false,
      refusal: {
        kind: "no_workflow",
        message:
          `no workflow could be resolved for project '${projectKey}': the dispatcher policy carries no ` +
          `default workflow and none was supplied. Set one with the dispatcher policy rather than letting ` +
          `a claimed ticket launch under a guess.`,
      },
    };
  }

  let projectDir = input.projectDir;
  if (projectDir === undefined) {
    const observed = observedCheckouts(projectKey);
    if (observed.length === 0) {
      return {
        ok: false,
        refusal: {
          kind: "no_checkout",
          message:
            `no checkout directory has ever been observed for project '${projectKey}' — neither an imported ` +
            `ticket source directory nor a run in this project carries one. A run cannot be launched without ` +
            `a project directory to mount; supply one explicitly.`,
        },
      };
    }
    if (observed.length > 1) {
      return {
        ok: false,
        refusal: {
          kind: "ambiguous_checkout",
          message:
            `project '${projectKey}' has ${observed.length} observed checkout directories ` +
            `(${observed.join(", ")}), which is the linked-worktree shape. Choosing one would run this ` +
            `ticket's work in a directory the operator did not pick, so the dispatch refuses and asks for ` +
            `an explicit checkout instead.`,
        },
      };
    }
    projectDir = observed[0] as string;
  }

  if (!existsSync(projectDir)) {
    return {
      ok: false,
      refusal: {
        kind: "missing_checkout",
        message:
          `the checkout recorded for project '${projectKey}' does not exist on this host: ${projectDir}. ` +
          `Every launch is started IN its directory, so this is refused here by name rather than dying ` +
          `inside the tmux pane as an ENOENT that reads as if the launched command were at fault.`,
      },
    };
  }

  return { ok: true, target: { projectKey, ticketId, title: ticket.title, workflow, projectDir } };
}

/**
 * THE ARGV. The ordinary SINGLE-TICKET run path and nothing else:
 *
 *   forge new <workflow> "<title>" --ticket <id> --project <dir>
 *
 * No campaign verb, no campaign plan, no implicit campaign creation (FG-591's
 * non-goals name all three). The `env FORGE_HOME=… FORGE_DB_PATH=…` prefix is the
 * campaign launcher's, for its stated reason: a long-lived tmux server does not pick
 * up the launcher's environment, so the child would otherwise open a DIFFERENT store
 * than the dispatcher and the run would never be discoverable from this claim.
 */
export function buildDispatchArgv(forgeBin: readonly string[], target: DispatchTarget): string[] {
  return [
    "env",
    `FORGE_HOME=${FORGE_HOME}`,
    `FORGE_DB_PATH=${DB_PATH}`,
    ...forgeBin,
    "new",
    target.workflow,
    target.title,
    "--ticket",
    target.ticketId,
    "--project",
    target.projectDir,
  ];
}

// ─── discovering execution that already exists ───────────────────────────────

export type RunDiscovery =
  | { kind: "found"; runId: string }
  /** Nothing yet. A claim in this state has started nothing OBSERVABLE, and the
   *  caller must NOT conclude the reservation is done. */
  | { kind: "none"; detail: string }
  /** More than one candidate. Binding one arbitrarily would make the dispatcher
   *  release its reservation when the WRONG run finishes, so it refuses and says so. */
  | { kind: "ambiguous"; detail: string; candidates: string[] };

/**
 * Find the run this claim's launch created, from DURABLE evidence only.
 *
 * `forge new --ticket <id>` stamps the ticket into run metadata at run creation
 * (startRun: metadata = {...inputs}), BEFORE any task spawns — so this binds earlier
 * than ticket_dispatch_evidence, which is only written when a spawned task carries a
 * ticket id (src/v2/spawn.ts). Narrowed by the LAUNCH's own recorded directory and
 * start time, so an operator's independent `forge new --ticket` for the same ticket
 * in another checkout, or one that predates this reservation, is not adopted.
 *
 * A launch id is REQUIRED. Without one there is no window to narrow to, and a bare
 * "some run mentions this ticket" match is exactly the kind of inference that binds a
 * reservation to work it never started.
 */
export function discoverRunForClaim(claim: QueueClaim): RunDiscovery {
  if (claim.launchId === null) {
    return { kind: "none", detail: "the claim carries no launch stamp, so there is no launch window to bind a run within" };
  }
  const observation = getLaunchObservation(claim.launchId);
  if (!observation) {
    return {
      kind: "none",
      detail: `launch ${claim.launchId} has no observation row, so the directory and instant to bind a run within are unknown`,
    };
  }
  const rows = getDb()
    .prepare(
      `SELECT id, created_at FROM runs
        WHERE json_extract(metadata, '$.ticketId') = ?
          AND project_dir = ?
          AND created_at >= ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(claim.ticketId, observation.cwd, observation.startedAt) as { id: string; created_at: string }[];

  if (rows.length === 0) {
    return { kind: "none", detail: `no run for ${claim.ticketId} was created in ${observation.cwd} after ${observation.startedAt}` };
  }
  if (rows.length > 1) {
    return {
      kind: "ambiguous",
      detail:
        `${rows.length} runs for ${claim.ticketId} were created in ${observation.cwd} after this launch started, ` +
        `so which one this reservation covers cannot be decided from durable evidence`,
      candidates: rows.map((r) => r.id),
    };
  }
  return { kind: "found", runId: (rows[0] as { id: string }).id };
}

/**
 * A container started under a claim whose stamp never landed — the crash window
 * between startLaunch returning and recordClaimLaunch committing.
 *
 * Found through the SUBMITTER'S DECLARED association on the launch row (ticket_id),
 * which launch-observations names as the one authorized channel, plus the claim's own
 * time window. Never through a launch name, its argv or its log (FG-492).
 */
export function discoverOrphanLaunch(claim: QueueClaim): LaunchObservation | null {
  const rows = getDb()
    .prepare(
      `SELECT launch_id FROM launch_observations
        WHERE ticket_id = ? AND terminal = 0 AND started_at >= ?
        ORDER BY started_at ASC, launch_id ASC`,
    )
    .all(claim.ticketId, claim.claimedAt) as { launch_id: string }[];
  if (rows.length !== 1) return null;
  return getLaunchObservation((rows[0] as { launch_id: string }).launch_id) ?? null;
}

// ─── launching (and adopting) ────────────────────────────────────────────────

export type LaunchClaimInput = {
  /** The claim AS GRANTED — this module never claims anything itself. */
  claim: QueueClaim;
  /** The forge binary argv prefix, exactly as campaign.ts's forgeSelfArgv supplies it
   *  to the drive-item launcher. Passed in rather than derived so this module never
   *  reaches for process.argv. */
  forgeBin: readonly string[];
  /** FG-610's `takenOverFrom`: the RETIRED predecessor when this grant recovered an
   *  expired lease, carrying its launch and run identity. */
  takenOverFrom?: QueueClaim | null;
  projectDir?: string | undefined;
  workflow?: string | undefined;
  /** Recorded on the refusal evaluation so the operator surface can attribute it. */
  dispatcherOwner?: string | undefined;
  dispatcherGeneration?: number | null;
  seams?: ExecutionSeams;
};

export type LaunchClaimResult =
  /** A container was started for this reservation. */
  | { kind: "launched"; launchId: string; claim: QueueClaim; argv: string[] }
  /** A takeover found live prior execution and ADOPTED it. No second container. */
  | { kind: "adopted"; launchId: string | null; runId: string | null; claim: QueueClaim; detail: string }
  /** A takeover found the prior execution already TERMINAL. The reservation is
   *  retired with the outcome that execution reached — never re-run. */
  | { kind: "already_terminal"; outcome: ReleaseOutcome; released: QueueClaim | null; detail: string }
  /** The launch target could not be resolved. The reservation is released
   *  `launch_failed` (the ticket is immediately re-claimable) and the refusal is
   *  RECORDED. */
  | { kind: "refused"; refusal: DispatchTargetRefusal; released: QueueClaim | null; evaluation: DispatcherEvaluation | null }
  /** startLaunch threw, or the durable stamp was refused. Same disposition. */
  | { kind: "launch_failed"; error: string; released: QueueClaim | null; evaluation: DispatcherEvaluation | null };

/**
 * RECORD a launch-path refusal as a dispatcher evaluation.
 *
 * VOCABULARY NOTE, stated rather than hidden: DISPATCH_REASONS is a CLOSED set owned
 * by step 3 and it has no "could not launch" member. `no_eligible_work` is the
 * least-wrong of the six for this pass — nothing ended up claimed and it was not
 * capacity, not disarmed, not a compatibility wait and not a lost re-validation — and
 * the concrete cause lives in `detail`, which is what every operator surface renders.
 * The row deliberately carries NO claim id: by the time it is written the reservation
 * has been RELEASED, so the pass's net effect really is "nothing is reserved", and
 * recordEvaluation refuses a refusal row that carries a claim.
 */
function recordTargetRefusal(input: {
  claim: QueueClaim;
  dispatcherOwner: string;
  dispatcherGeneration: number | null;
  detail: string;
}): DispatcherEvaluation | null {
  try {
    return recordEvaluation({
      projectKey: input.claim.projectKey,
      dispatcherOwner: input.dispatcherOwner,
      dispatcherGeneration: input.dispatcherGeneration,
      reason: "no_eligible_work",
      detail: input.detail,
    });
  } catch {
    // The journal is evidence, not authorization: a store that cannot record why
    // must not also prevent the release that keeps the ticket re-claimable.
    return null;
  }
}

/**
 * Launch the work a granted claim reserves — or ADOPT the execution a predecessor
 * already started.
 *
 * ORDER, and every step of it load-bearing:
 *   1. ADOPTION FIRST. A takeover whose predecessor carries a launch or a run adopts
 *      it. Starting a second container for work whose first container may still be
 *      running is the duplicate execution the whole design prevents, and an expired
 *      lease proves only that HEARTBEATING stopped.
 *   2. Resolve the target. An unresolvable checkout or workflow releases
 *      `launch_failed` and RECORDS why — the ticket is immediately re-claimable and
 *      the operator is told, rather than the queue silently stalling.
 *   3. startLaunch under tmux ownership transfer, with the ordinary single-ticket argv.
 *   4. recordClaimLaunch IMMEDIATELY, before anything else. If the stamp is refused
 *      (the lease lapsed under us, or a takeover superseded our generation) the
 *      container is force-removed rather than left orphaned: we are no longer
 *      authorized to make anything durable about it, so it must not keep running.
 *   5. recordLaunchStart last — instrumentation, best-effort by its own contract, and
 *      the durable ticket association a later orphan discovery reads.
 */
export function launchClaimedTicket(input: LaunchClaimInput): LaunchClaimResult {
  const { claim, forgeBin } = input;
  const seams = input.seams ?? {};
  const dispatcherOwner = input.dispatcherOwner ?? claim.owner;
  const dispatcherGeneration = input.dispatcherGeneration ?? null;

  // ── 1. adoption ────────────────────────────────────────────────────────────
  const adoption = resolveAdoption(claim, input.takenOverFrom ?? null);
  if (adoption.kind === "adopt") {
    const stamped = recordClaimLaunch({
      projectKey: claim.projectKey,
      claimId: claim.id,
      owner: claim.owner,
      generation: claim.generation,
      ...(adoption.launchId !== null ? { launchId: adoption.launchId } : {}),
      ...(adoption.runId !== null ? { runId: adoption.runId } : {}),
    });
    return {
      kind: "adopted",
      launchId: adoption.launchId,
      runId: adoption.runId,
      claim: stamped ?? claim,
      detail: adoption.detail,
    };
  }
  if (adoption.kind === "already_terminal") {
    return {
      kind: "already_terminal",
      outcome: adoption.outcome,
      released: releaseReservation(claim, adoption.outcome),
      detail: adoption.detail,
    };
  }

  // ── 2. the target ──────────────────────────────────────────────────────────
  const resolved = resolveDispatchTarget({
    projectKey: claim.projectKey,
    ticketId: claim.ticketId,
    projectDir: input.projectDir,
    workflow: input.workflow,
  });
  if (!resolved.ok) {
    const released = releaseReservation(claim, "launch_failed");
    const evaluation = recordTargetRefusal({
      claim,
      dispatcherOwner,
      dispatcherGeneration,
      detail:
        `claim ${claim.id} for ${claim.ticketId} was granted and then released 'launch_failed' — ` +
        `${resolved.refusal.message}`,
    });
    return { kind: "refused", refusal: resolved.refusal, released, evaluation };
  }

  // ── 3. the physical launch ─────────────────────────────────────────────────
  const argv = buildDispatchArgv(forgeBin, resolved.target);
  let meta: LaunchMeta;
  try {
    meta = seamStartLaunch(seams)(argv, {
      name: `queue-claim-${claim.ticketId}`,
      cwd: resolved.target.projectDir,
    });
  } catch (e) {
    const message = (e as Error).message;
    const released = releaseReservation(claim, "launch_failed");
    const evaluation = recordTargetRefusal({
      claim,
      dispatcherOwner,
      dispatcherGeneration,
      detail: `claim ${claim.id} for ${claim.ticketId} was released 'launch_failed' — the launch threw: ${message}`,
    });
    return { kind: "launch_failed", error: message, released, evaluation };
  }

  // ── 4. the durable stamp, FIRST and alone ──────────────────────────────────
  const stamped = recordClaimLaunch({
    projectKey: claim.projectKey,
    claimId: claim.id,
    owner: claim.owner,
    generation: claim.generation,
    launchId: meta.id,
  });
  if (stamped === null) {
    // We are fenced: a stale generation, or a lease that lapsed while tmux started.
    // An unstampable launch is an ORPHAN — the successor would find no pointer to it —
    // so it is removed rather than left running, and the release is ATTEMPTED but not
    // assumed (releaseClaim is lease-fenced too; if it refuses, lease expiry plus
    // takeover is the recovery path and the record says so).
    try {
      seamRemoveLaunch(seams)(meta.id, { force: true });
    } catch {
      /* best-effort kill of the unstampable child */
    }
    const released = releaseReservation(claim, "launch_failed");
    const evaluation = recordTargetRefusal({
      claim,
      dispatcherOwner,
      dispatcherGeneration,
      detail:
        `claim ${claim.id} for ${claim.ticketId} started launch ${meta.id} and could not stamp it — the ` +
        `owner/generation fence or the lease refused. The container was removed rather than left orphaned.`,
    });
    return {
      kind: "launch_failed",
      error: `the launch stamp was refused for claim ${claim.id} at generation ${claim.generation}`,
      released,
      evaluation,
    };
  }

  // ── 5. the observation (best-effort by contract; the ticket association a later
  //      orphan discovery reads) ────────────────────────────────────────────────
  try {
    seamRecordLaunchStart(seams)(meta, { ticketId: claim.ticketId });
  } catch {
    /* unobserved, never unlaunched */
  }

  return { kind: "launched", launchId: meta.id, claim: stamped, argv };
}

type AdoptionDecision =
  | { kind: "adopt"; launchId: string | null; runId: string | null; detail: string }
  | { kind: "already_terminal"; outcome: ReleaseOutcome; detail: string }
  | { kind: "launch"; detail: string };

/** Adopt-or-launch, decided from the predecessor's durable identity and the current
 *  state of what it pointed at. Reads the RESERVATION and the EXECUTION separately. */
function resolveAdoption(claim: QueueClaim, predecessor: QueueClaim | null): AdoptionDecision {
  // Our OWN claim may already carry a stamp (a retry after a crash between the stamp
  // and its ack). Adopting our own stamp is idempotent and must never relaunch.
  if (claim.launchId !== null || claim.runId !== null) {
    return {
      kind: "adopt",
      launchId: claim.launchId,
      runId: claim.runId,
      detail: `claim ${claim.id} already carries its own launch identity; nothing is started twice`,
    };
  }

  const priorRunId = predecessor?.runId ?? null;
  const priorLaunchId = predecessor?.launchId ?? null;

  if (priorRunId !== null) {
    const run = getRun(priorRunId);
    if (run && !isTerminalRunStatus(run.status)) {
      return {
        kind: "adopt",
        launchId: priorLaunchId,
        runId: priorRunId,
        detail: `adopted run ${priorRunId} (${run.status}) from the predecessor claim ${predecessor?.id ?? "?"}`,
      };
    }
    if (run) {
      return {
        kind: "already_terminal",
        outcome: outcomeForRunStatus(run.status),
        detail: `the predecessor's run ${priorRunId} is already ${run.status}; the reservation is retired rather than re-run`,
      };
    }
    // A run id the store does not have is NOT evidence that nothing ran. Adopt the
    // pointer rather than launching a second container against an unknown.
    return {
      kind: "adopt",
      launchId: priorLaunchId,
      runId: priorRunId,
      detail: `the predecessor recorded run ${priorRunId}, which has no row in this store; adopted rather than duplicated`,
    };
  }

  if (priorLaunchId !== null) {
    const observation = getLaunchObservation(priorLaunchId);
    if (!observation || !observation.terminal) {
      return {
        kind: "adopt",
        launchId: priorLaunchId,
        runId: null,
        detail:
          observation === undefined
            ? `the predecessor recorded launch ${priorLaunchId}, which this store never observed; adopted rather than duplicated`
            : `adopted the predecessor's still-live launch ${priorLaunchId}`,
      };
    }
    // The predecessor's launch is terminal. `forge new` exits as soon as the run is
    // created, so a terminal launch says nothing about the WORK: adopt it and let the
    // reconcile bind the run it created.
    return {
      kind: "adopt",
      launchId: priorLaunchId,
      runId: null,
      detail: `adopted the predecessor's completed launch ${priorLaunchId}; its run, if any, binds on reconcile`,
    };
  }

  // No predecessor identity at all. Before launching, look for the container the
  // crash window can strand: a launch that declared THIS ticket and started after
  // this reservation did.
  const orphan = discoverOrphanLaunch(claim);
  if (orphan) {
    return {
      kind: "adopt",
      launchId: orphan.launchId,
      runId: null,
      detail: `adopted orphaned launch ${orphan.launchId}, which declared ${claim.ticketId} and is still live`,
    };
  }

  return { kind: "launch", detail: "no prior execution is discoverable for this reservation" };
}

// ─── heartbeat ───────────────────────────────────────────────────────────────

export type HeartbeatResult = {
  claimId: string;
  ticketId: string;
  /** true when the lease was renewed. false means the fence refused: a superseded
   *  generation, or a lease that STRICTLY lapsed. A dispatcher that sees this has
   *  LOST the claim and must stop driving it — re-entry is takeoverExpiredClaim,
   *  never a pretend renewal. */
  renewed: boolean;
};

/** Whether a claim is due for its next heartbeat on the POLICY cadence, on the store
 *  clock. Separated from the write so a loop can decide without writing. */
export function claimDueForHeartbeat(claim: QueueClaim, policy: DispatcherPolicy, nowMs: number): boolean {
  return claim.heartbeatAtMs + policy.heartbeatMs <= nowMs;
}

/**
 * Heartbeat every LIVE claim this owner holds in the project, on the policy cadence
 * and with the policy TTL.
 *
 * Deliberately NOT gated on `armed` (D5): a disarmed dispatcher keeps renewing the
 * leases it already holds, because a lease that lapses over a running container
 * invites a takeover and a duplicate. Disarm blocks NEW claims and nothing else.
 */
export function heartbeatOwnedClaims(input: {
  projectKey: string;
  owner: string;
  policy?: DispatcherPolicy;
  /** Renew every owned claim regardless of cadence — used on a wake, where the point
   *  is to prove liveness immediately rather than to pace writes. */
  force?: boolean;
}): HeartbeatResult[] {
  const policy = input.policy ?? getDispatcherPolicy(input.projectKey);
  const now = storeNowMs();
  const mine = liveClaims(input.projectKey).filter((c) => c.owner === input.owner);
  const results: HeartbeatResult[] = [];
  for (const claim of mine) {
    if (!input.force && !claimDueForHeartbeat(claim, policy, now)) continue;
    const renewed = heartbeatClaim({
      projectKey: claim.projectKey,
      claimId: claim.id,
      owner: claim.owner,
      generation: claim.generation,
      leaseTtlMs: policy.leaseTtlMs,
    });
    results.push({ claimId: claim.id, ticketId: claim.ticketId, renewed: renewed !== null });
  }
  return results;
}

// ─── observing the execution, and retiring the reservation ───────────────────

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["complete", "failed", "abandoned"]);

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** A terminal RUN status mapped onto a RESERVATION outcome. `abandoned` is the
 *  durable trace `forge cancel --abandon-run` leaves, so it retires the reservation
 *  as `cancelled` rather than as `failed`: the work was stopped, it did not fail. */
function outcomeForRunStatus(status: string): ReleaseOutcome {
  if (status === "complete") return "completed";
  if (status === "abandoned") return "cancelled";
  return "failed";
}

export type ExecutionVerdict =
  | { kind: "not_found"; detail: string }
  | { kind: "already_released"; detail: string; outcome: string | null }
  /** Live reservation, nothing started yet. NEVER a reason to release. */
  | { kind: "pending_launch"; detail: string }
  | { kind: "running"; detail: string }
  /** The launch is terminal but which run it produced cannot be decided. The
   *  reservation is HELD: releasing here would re-admit a ticket whose container may
   *  still be doing work under one of the candidate runs. */
  | { kind: "unresolved"; detail: string }
  | { kind: "terminal"; outcome: ReleaseOutcome; detail: string };

export type ExecutionView = {
  claimId: string;
  ticketId: string;
  /** THE RESERVATION half, from queue_claims alone. */
  reservation: {
    state: string;
    owner: string;
    generation: number;
    launchId: string | null;
    runId: string | null;
    leaseExpiresAtMs: number;
    leaseLive: boolean;
  } | null;
  /** THE EXECUTION half, from the run and launch records alone. Read separately and
   *  joined here in memory — never in one query. */
  execution: {
    runId: string | null;
    runStatus: string | null;
    runTerminal: boolean;
    launchId: string | null;
    launchTerminal: boolean | null;
    launchState: string | null;
  };
  verdict: ExecutionVerdict;
  nowMs: number;
};

/** A pure READ of both halves. Writes nothing, releases nothing, and is safe to call
 *  from an operator surface. */
export function observeClaimExecution(input: { projectKey: string; claimId: string }): ExecutionView {
  const now = storeNowMs();
  const claim = getClaim(input.projectKey, input.claimId);
  if (!claim) {
    return {
      claimId: input.claimId,
      ticketId: "",
      reservation: null,
      execution: { runId: null, runStatus: null, runTerminal: false, launchId: null, launchTerminal: null, launchState: null },
      verdict: { kind: "not_found", detail: `no claim ${input.claimId} in project ${input.projectKey}` },
      nowMs: now,
    };
  }

  // THE EXECUTION half, read on its own.
  const run = claim.runId === null ? undefined : getRun(claim.runId);
  const observation = claim.launchId === null ? undefined : getLaunchObservation(claim.launchId);
  const execution = {
    runId: claim.runId,
    runStatus: run?.status ?? null,
    runTerminal: run !== undefined && isTerminalRunStatus(run.status),
    launchId: claim.launchId,
    launchTerminal: observation === undefined ? null : observation.terminal,
    launchState: observation?.status.state ?? null,
  };

  const reservation = {
    state: claim.state,
    owner: claim.owner,
    generation: claim.generation,
    launchId: claim.launchId,
    runId: claim.runId,
    leaseExpiresAtMs: claim.leaseExpiresAtMs,
    leaseLive: claim.leaseExpiresAtMs >= now,
  };

  return {
    claimId: claim.id,
    ticketId: claim.ticketId,
    reservation,
    execution,
    verdict: verdictFor(claim, run?.status ?? null, observation),
    nowMs: now,
  };
}

function verdictFor(claim: QueueClaim, runStatus: string | null, observation: LaunchObservation | undefined): ExecutionVerdict {
  if (claim.state !== "live") {
    return { kind: "already_released", detail: `claim ${claim.id} was released as '${claim.outcome ?? "?"}'`, outcome: claim.outcome };
  }
  if (claim.runId !== null) {
    if (runStatus === null) {
      return { kind: "unresolved", detail: `run ${claim.runId} is stamped on the claim but has no row in this store` };
    }
    if (isTerminalRunStatus(runStatus)) {
      return { kind: "terminal", outcome: outcomeForRunStatus(runStatus), detail: `run ${claim.runId} is ${runStatus}` };
    }
    return { kind: "running", detail: `run ${claim.runId} is ${runStatus}` };
  }
  if (claim.launchId === null) {
    return { kind: "pending_launch", detail: `claim ${claim.id} holds a reservation with no launch stamped yet` };
  }
  if (observation === undefined || !observation.terminal) {
    return { kind: "running", detail: `launch ${claim.launchId} has not been observed terminal` };
  }
  // The launch is terminal and no run is bound. `forge new` inserts the run BEFORE it
  // exits, so a terminal launch with no discoverable run means no run was ever
  // created — the reservation ends having started nothing.
  const discovery = discoverRunForClaim(claim);
  if (discovery.kind === "found") {
    return { kind: "unresolved", detail: `run ${discovery.runId} is discoverable but not yet bound to this claim` };
  }
  if (discovery.kind === "ambiguous") {
    return { kind: "unresolved", detail: discovery.detail };
  }
  return {
    kind: "terminal",
    outcome: "launch_failed",
    detail: `launch ${claim.launchId} ended ${observation.status.state} without creating a run — ${discovery.detail}`,
  };
}

export type ReconcileResult = {
  view: ExecutionView;
  /** The run id this pass BOUND to the claim, if any (write-once per generation). */
  bound: string | null;
  released: QueueClaim | null;
  /** Set when a terminal execution was observed and the release was REFUSED by the
   *  fence — an expired owner cannot retire its own claim (queue-claims states why:
   *  releasing deletes the recovery record). Surfaced, never swallowed. */
  releaseRefused: string | null;
};

/**
 * Bind the run this claim's launch created, then retire the reservation once its
 * EXECUTION is terminal.
 *
 * The two halves stay separate throughout: the run status decides whether work is
 * over, the claim row decides who may retire the reservation, and the release is
 * issued by the lease OWNER carried on the claim itself.
 */
export function reconcileClaimExecution(input: {
  projectKey: string;
  claimId: string;
  seams?: ExecutionSeams;
}): ReconcileResult {
  const seams = input.seams ?? {};
  // Copy on-disk terminal evidence into the observation store first (FG-679's
  // opportunistic promoter — no daemon, no probe, no fabrication). Best-effort: a
  // failing sweep must never take down the reconcile that hosts it.
  try {
    seamPromote(seams)();
  } catch {
    /* an unpromotable launch record is not a reason to stop reconciling */
  }

  let claim = getClaim(input.projectKey, input.claimId);
  let bound: string | null = null;
  if (claim && claim.state === "live" && claim.runId === null && claim.launchId !== null) {
    const discovery = discoverRunForClaim(claim);
    if (discovery.kind === "found") {
      const stamped = recordClaimLaunch({
        projectKey: claim.projectKey,
        claimId: claim.id,
        owner: claim.owner,
        generation: claim.generation,
        runId: discovery.runId,
      });
      if (stamped !== null) {
        bound = discovery.runId;
        claim = stamped;
      }
    }
  }

  const view = observeClaimExecution({ projectKey: input.projectKey, claimId: input.claimId });
  if (view.verdict.kind !== "terminal" || claim === undefined) {
    return { view, bound, released: null, releaseRefused: null };
  }

  const released = releaseReservation(claim, view.verdict.outcome);
  return {
    view,
    bound,
    released,
    releaseRefused:
      released === null
        ? `claim ${claim.id} observed terminal (${view.verdict.detail}) but the release was refused by the ` +
          `owner/generation/lease fence — an expired owner cannot retire its own claim, because that would ` +
          `delete the recovery record a successor needs. Recovery is takeoverExpiredClaim.`
        : null,
  };
}

// ─── cancel (D4): stop the work FIRST, then retire the reservation ───────────

export type CancelClaimResult =
  /** There is no live reservation for this ticket. NOTHING was released — an
   *  operator dequeue/unrank/defer reaching this module would land here. */
  | { kind: "no_live_claim"; detail: string }
  | {
      kind: "cancelled";
      claimId: string;
      /** The `forge cancel` outcome, or null when the reservation had no run to stop
       *  (the pre-launch window). */
      cancelOutcome: CancelOutcome | null;
      launchRemoved: string | null;
      released: QueueClaim | null;
      /** Non-null when the work was stopped but the reservation could not be retired
       *  by this owner. The work is stopped either way — that ordering is the point. */
      releaseRefused: string | null;
    };

/**
 * THE explicit cancel path FG-591 owns.
 *
 * The order is asymmetric and is the whole safety argument:
 *   1. STOP THE WORK through the existing `forge cancel` seam — the run's containers
 *      are killed and its tasks failed, exactly as the CLI verb does.
 *   2. Remove the launch, so the tmux-owned wrapper cannot keep running.
 *   3. ONLY THEN release the reservation, as `cancelled`, issued by the LEASE OWNER.
 *
 * Reversing 1 and 3 re-admits the ticket to the scan while its container still runs,
 * and a second dispatcher claims work that is already executing. That is the
 * duplicate execution the claim primitive exists to prevent, so the ordering is
 * structural here (the release is unreachable before the stop) rather than a comment.
 */
export function cancelClaimedTicket(input: {
  projectKey: string;
  ticketId: string;
  /** Abandon the run as well as killing its tasks. Default true: a cancelled
   *  reservation whose run stayed `active` with no live task would render In progress
   *  on the board forever. */
  abandonRun?: boolean;
  seams?: ExecutionSeams;
}): CancelClaimResult {
  const seams = input.seams ?? {};
  const claim = liveClaims(input.projectKey).find((c) => c.ticketId === input.ticketId);
  if (!claim) {
    return {
      kind: "no_live_claim",
      detail:
        `no live claim reserves ${input.ticketId} in project ${input.projectKey}, so there is nothing to stop ` +
        `and nothing to release. Queue membership is planning intent; it is never a reservation.`,
    };
  }

  // 1. THE WORK, FIRST.
  let cancelOutcome: CancelOutcome | null = null;
  if (claim.runId !== null) {
    cancelOutcome = seamCancelWork(seams)({ runId: claim.runId, abandonRun: input.abandonRun ?? true });
  }

  // 2. The launch, so the tmux-owned wrapper stops too.
  let launchRemoved: string | null = null;
  if (claim.launchId !== null) {
    try {
      seamRemoveLaunch(seams)(claim.launchId, { force: true });
      launchRemoved = claim.launchId;
    } catch {
      /* best-effort: a launch record that cannot be removed does not block the release */
    }
  }

  // 3. THE RESERVATION, LAST, and by its own owner+generation.
  const released = releaseReservation(claim, "cancelled");
  return {
    kind: "cancelled",
    claimId: claim.id,
    cancelOutcome,
    launchRemoved,
    released,
    releaseRefused:
      released === null
        ? `the work for ${input.ticketId} was stopped, but claim ${claim.id} could not be retired by ` +
          `${claim.owner}#${claim.generation}: the owner/generation/lease fence refused. The reservation ` +
          `lapses and is recovered by takeover; nothing is running under it.`
        : null,
  };
}

// ─── retiring a reservation that never became execution ──────────────────────

export type SupersedeResult =
  | { kind: "superseded"; released: QueueClaim | null }
  | { kind: "refused"; reason: "not_found" | "not_live" | "has_execution" | "too_young"; detail: string };

/**
 * Retire a reservation that never became execution — `superseded`.
 *
 * GUARDED HARD, because the failure mode is the worst one available: releasing a
 * claim whose container is starting RIGHT NOW re-admits the ticket and duplicates the
 * run. So this refuses unless ALL of the following hold:
 *   * the claim is live and carries NO launch id and NO run id;
 *   * no orphaned launch declaring this ticket is discoverable;
 *   * the claim is older than `minAgeMs` — by default the policy heartbeat cadence,
 *     which is comfortably longer than the stamp window in launchClaimedTicket.
 *
 * This is not a dequeue path and is never reached by one: it is the LEASE OWNER
 * observing that its own reservation points at nothing.
 */
export function supersedeUnlaunchedClaim(input: {
  projectKey: string;
  claimId: string;
  minAgeMs?: number;
}): SupersedeResult {
  const claim = getClaim(input.projectKey, input.claimId);
  if (!claim) return { kind: "refused", reason: "not_found", detail: `no claim ${input.claimId}` };
  if (claim.state !== "live") {
    return { kind: "refused", reason: "not_live", detail: `claim ${claim.id} is already ${claim.state}` };
  }
  if (claim.launchId !== null || claim.runId !== null) {
    return {
      kind: "refused",
      reason: "has_execution",
      detail:
        `claim ${claim.id} carries launch=${claim.launchId ?? "-"} run=${claim.runId ?? "-"}; a reservation ` +
        `pointing at execution is retired by observing that execution, never by superseding it`,
    };
  }
  const orphan = discoverOrphanLaunch(claim);
  if (orphan) {
    return {
      kind: "refused",
      reason: "has_execution",
      detail: `launch ${orphan.launchId} declared ${claim.ticketId} after this claim began and is still live`,
    };
  }
  const minAgeMs = input.minAgeMs ?? getDispatcherPolicy(input.projectKey).heartbeatMs;
  const ageMs = storeNowMs() - Date.parse(claim.claimedAt);
  if (!(ageMs >= minAgeMs)) {
    return {
      kind: "refused",
      reason: "too_young",
      detail:
        `claim ${claim.id} is ${ageMs}ms old and the floor is ${minAgeMs}ms — a younger unlaunched claim may ` +
        `be one whose container is starting at this instant, and releasing it would duplicate the run`,
    };
  }
  return { kind: "superseded", released: releaseReservation(claim, "superseded") };
}
