// FG-703: the canonical adjudication-identity contract.
//
// A narrow, operator-authorized adjudication lifecycle retires an exact
// orphaned_work_may_persist ops incident (outcome no_unique_work) from the
// active high-severity report while preserving the failed task, failed run,
// detector evidence, rationale, actor and timestamp as durable audit history.
//
// This module owns the ONE identity function used at BOTH the adjudication-write
// side and the detection-suppression side — neither re-derives identity
// independently. Incident identity is a pure function of detector-owned
// STRUCTURED facts on the latest task.failed payload; it never reads rendered
// evidence text and never performs a live re-scan.
//
// The field partition is the central design decision (AC1):
//
//   IDENTITY-BEARING (a change here is a materially different WORK incident, so
//   the adjudication no longer applies and the incident reappears as unresolved):
//     - anchor:            runId, taskId
//     - failure_kind
//     - work-output facts: resultState, recoverableStdoutResult
//     - evidence source:   source ("worktree" | "project_dir_shared")
//     - terminal cause:    containerExitedEventObserved, exitCode, oomKilled, signal
//     - changed-file SET:  ONLY when source === "worktree" (a dedicated,
//                          task-exclusive worktree — a stable fact about THIS
//                          task's work), as a sorted, de-duplicated set.
//
//   VOLATILE / EXCLUDED (a change here must NOT invalidate an adjudication):
//     - changedFiles when source !== "worktree" (the four live incidents share a
//       dirty project_dir_shared checkout whose changed-file count differs on
//       every re-scan — hashing it would invalidate every adjudication on the
//       next `forge ops check`)
//     - worktreePathChecked and every absolute path
//     - startedAt / finishedAt and every other timestamp
//     - dockerStateError / resultWriteFailed (best-effort prose diagnostics)
//     - the top-level rendered `error` string and every rendered evidence[] line
//
// This is a strict superset of the notify dedupe key (kind+runId+taskId,
// ops.ts:40): that key is too weak — a genuinely NEW incident on the same task
// would inherit a stale adjudication. Binding identity to the structured work
// facts above fixes both failure modes at once (over-broad whole-evidence hash
// and under-broad anchor-only key).

import type { Database as DatabaseInstance } from "better-sqlite3";
import type { OrphanEvidence } from "../v2/failure-kind.js";
import { sha256OfString } from "../util/content-digest.js";
import { provenSameOnly } from "../util/path-identity.js";
import { getDb, writeTransaction } from "../store/db.js";
import { getTask } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { nowIso } from "../util/ids.js";

/** The structured facts an incident's identity is derived from. Both the write
 *  side (performAdjudicate) and the detect side (detectOrphanedWorkMayPersist)
 *  assemble this from the SAME source — the anchor (runId, taskId) off the task
 *  row and the failure_kind + evidence off the latest task.failed payload — and
 *  hand it here. Neither side re-derives the identity string itself. */
export type AdjudicationIdentityInput = {
  runId: string;
  taskId: string;
  failureKind: string;
  /** The OrphanEvidence tuple off the latest task.failed payload, when present.
   *  A pre-evidence task.failed (or a kind that records none) omits it. */
  evidence?: OrphanEvidence | undefined;
};

// The identity-bearing projection, with a FIXED key order so JSON.stringify is
// deterministic. A field the evidence does not carry is recorded as null rather
// than omitted, so "field absent" and "field present but volatile" never collide
// on the same serialized shape.
type CanonicalIdentity = {
  runId: string;
  taskId: string;
  failureKind: string;
  resultState: OrphanEvidence["resultState"] | null;
  recoverableStdoutResult: boolean | null;
  source: OrphanEvidence["source"] | null;
  containerExitedEventObserved: boolean | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  signal: string | null;
  // The sorted, de-duplicated changed-file SET — ONLY when source === "worktree".
  // null for project_dir_shared / no-source evidence and for no-evidence: the
  // shared-checkout changed-file list is volatile and must not bind identity.
  worktreeChangedFiles: string[] | null;
};

function canonicalIdentity(input: AdjudicationIdentityInput): CanonicalIdentity {
  const e = input.evidence;
  // A worktree-sourced diff is task-exclusive and stable; hash it as a SET
  // (sorted + de-duplicated) so file-order churn does not invalidate but a
  // genuinely different set of touched files does. Any other source (or none)
  // contributes no changed-file fact to identity.
  const worktreeChangedFiles =
    e && e.source === "worktree"
      ? Array.from(new Set(e.changedFiles)).sort()
      : null;
  return {
    runId: input.runId,
    taskId: input.taskId,
    failureKind: input.failureKind,
    resultState: e?.resultState ?? null,
    recoverableStdoutResult: e?.recoverableStdoutResult ?? null,
    source: e?.source ?? null,
    containerExitedEventObserved: e?.containerExitedEventObserved ?? null,
    exitCode: e?.exitCode ?? null,
    oomKilled: e?.oomKilled ?? null,
    signal: e?.signal ?? null,
    worktreeChangedFiles,
  };
}

/** The one canonical identity string for an incident, derived from detector-owned
 *  structured facts only. Stable across volatile churn (shared-checkout changed
 *  files, absolute paths, timestamps, rendered prose); changes when any
 *  identity-bearing WORK fact changes. Both the adjudication write and the
 *  detection suppression call this — neither re-derives it. */
export function computeAdjudicationIdentity(input: AdjudicationIdentityInput): string {
  // Fixed-key-order object → deterministic JSON → sha256. The object literal in
  // canonicalIdentity fixes the key order, so JSON.stringify is stable without a
  // custom serializer.
  return sha256OfString(JSON.stringify(canonicalIdentity(input)));
}

/** The detection-side read path: the CURRENT recorded adjudication identity(ies)
 *  for a task, as a set the suppression check (step 3, detectOrphanedWorkMayPersist)
 *  tests the freshly-computed identity against with `.has(...)`. Empty when the task
 *  was never adjudicated.
 *
 *  Only the LATEST `ops.adjudicated` event counts. An adjudication records the
 *  identity computed off the task.failed payload at write time; when that work
 *  materially changes and the incident reappears, the operator re-adjudicates and a
 *  NEW `ops.adjudicated` event supersedes the old one. Returning the latest — rather
 *  than every historical identity — keeps suppression bound to the operator's most
 *  recent decision: a superseded identity must NOT keep suppressing (fail-closed;
 *  see threat-model risk #2, a genuinely new incident inheriting a stale
 *  adjudication).
 *
 *  Reads the single latest event via the same latest-event-per-task selection the
 *  detectors use (detect.ts:267-272) — one prepared statement, one round trip over
 *  the read-only handle, no per-task event-stream walk. `$.identity` is the field
 *  performAdjudicate (step 4) writes into the ops.adjudicated payload. This helper
 *  only READS the record; it does not itself decide suppression. */
export function adjudicatedIdentitiesForTask(db: DatabaseInstance, taskId: string): Set<string> {
  const row = db
    .prepare(
      `SELECT json_extract(e.payload, '$.identity') AS identity
       FROM events e
       WHERE e.id = (
         SELECT e2.id FROM events e2
         WHERE e2.task_id = ? AND e2.event_type = 'ops.adjudicated'
         ORDER BY e2.created_at DESC, e2.id DESC
         LIMIT 1
       )`
    )
    .get(taskId) as { identity: string | null } | undefined;
  const identities = new Set<string>();
  // A pre-identity or malformed payload (json_extract → null / non-string) records
  // no usable identity: treat it as "not adjudicated for any current identity" so it
  // can never suppress. This never happens for records performAdjudicate writes, but
  // the read path stays fail-closed against a hand-edited or partial row.
  if (row && typeof row.identity === "string" && row.identity.length > 0) {
    identities.add(row.identity);
  }
  return identities;
}

// ── FG-703 step 4: the `forge ops adjudicate` write verb ──────────────────────
//
// An operator-authorized, fail-closed, APPEND-ONLY audit write. It retires ONE
// exact orphaned_work_may_persist incident (outcome no_unique_work) from the
// active high-severity report by recording a single ops.adjudicated event whose
// `identity` is computeAdjudicationIdentity over the CURRENT latest task.failed —
// the record the detection side (step 3) tests the freshly-computed identity
// against before suppressing. It writes NOTHING else: no markTaskFailed /
// updateRunStatus / restoreTaskFailed, no result-column write, and it never
// touches the original task.failed evidence. Failed stays failed; the failed run
// stays failed; no artifact is deleted.
//
// The whole surface FAILS CLOSED. Every refusal names the blocking fact and writes
// no event. Refusals (brief constraint 6):
//   - unknown incident        (no such task, or no live failed-task incident for it)
//   - unsupported incident kind (the task's current failure_kind does not present
//                                as an orphaned_work_may_persist incident under the
//                                detector's shared collapse mapping)
//   - unsupported outcome      (anything other than no_unique_work)
//   - missing/empty rationale
//   - project mismatch         (the incident's run does not belong to the scoped project)
//   - identity drift           (the incident's CURRENT identity no longer matches
//                               the record the operator inspected)

/** The incident kind a raw `failure_kind` presents as in `forge ops check`. The
 *  detector COLLAPSES many raw failure kinds into one incident kind: oom_killed
 *  and orphaned_needs_finalize keep their own kind; EVERY other failure kind
 *  (container_crash, idle_timeout, result_missing, fanout_wave_orphaned, and any
 *  future addition) presents as an orphaned_work_may_persist incident. */
export type IncidentKind = "oom_killed" | "orphaned_needs_finalize" | "orphaned_work_may_persist";

/** The ONE shared source of truth for "which failure kind presents as which
 *  incident kind". BOTH the detector (which EMITS the incident — detect.ts) and
 *  the adjudication write (which SCOPES on it — performAdjudicate) call this, so
 *  the set of failure kinds that present as an adjudicable orphaned_work_may_persist
 *  incident can never drift into two divergent literal lists. Anything that is not
 *  oom_killed or orphaned_needs_finalize collapses to orphaned_work_may_persist. */
export function incidentKindForFailureKind(failureKind: string): IncidentKind {
  if (failureKind === "oom_killed") return "oom_killed";
  if (failureKind === "orphaned_needs_finalize") return "orphaned_needs_finalize";
  return "orphaned_work_may_persist";
}

/** The one incident kind this verb may retire (brief constraint 2). */
const SUPPORTED_KIND = "orphaned_work_may_persist";
/** The one outcome this verb accepts (brief constraint 2). */
const SUPPORTED_OUTCOME = "no_unique_work";

export type AdjudicateInput = {
  /** The disposition. Only `no_unique_work` is accepted; anything else fails closed. */
  outcome: string;
  /** Operator's reason. Empty / whitespace-only fails closed — an audit record
   *  with no rationale is not an audit record. */
  rationale: string;
  /** WHO adjudicated. Recorded verbatim into the durable audit event. The CLI
   *  resolves a default (the OS user) so this is never blank. */
  actor: string;
  /** The project the operator is scoped to (cwd or --project, resolved). The
   *  incident's run must belong to it — a cross-project adjudication fails closed. */
  projectDir: string;
  /** REQUIRED compare-and-set token: the incident identity the operator INSPECTED.
   *  There is no supported way to adjudicate without naming the identity you
   *  inspected — the write refuses unless this still equals the identity recomputed
   *  from the current latest task.failed, both before the write and again under the
   *  write lock (the TOCTOU guard against adjudicating a record that materially
   *  changed since inspection — threat-model risk #4). */
  expectedIdentity: string;
};

export type AdjudicateResult =
  | {
      kind: "adjudicated";
      taskId: string;
      runId: string;
      identity: string;
      outcome: string;
      actor: string;
      at: string;
    }
  | { kind: "refused"; id: string; reason: string }
  | { kind: "unknown"; id: string };

/** The latest task.failed payload for a task (newest-first by created_at then id),
 *  parsed, or undefined when the task has none. Mirrors the correlated-subquery
 *  selection detectOrphanedWorkMayPersist (detect.ts:267-272) uses so the write
 *  side reads the SAME event the detect side classifies from. */
function latestFailedPayload(db: DatabaseInstance, taskId: string): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT e.payload AS payload
       FROM events e
       WHERE e.id = (
         SELECT e2.id FROM events e2
         WHERE e2.task_id = ? AND e2.event_type = 'task.failed'
         ORDER BY e2.created_at DESC, e2.id DESC
         LIMIT 1
       )`
    )
    .get(taskId) as { payload: string | null } | undefined;
  if (!row || row.payload === null) return undefined;
  return JSON.parse(row.payload) as Record<string, unknown>;
}

/** Assemble the identity input off a task's anchor + its latest task.failed
 *  payload, exactly the way both sides must. The identity string itself is
 *  derived ONLY by computeAdjudicationIdentity — this just gathers its inputs. */
function identityInputFor(runId: string, taskId: string, payload: Record<string, unknown>): AdjudicationIdentityInput {
  return {
    runId,
    taskId,
    failureKind: payload["failure_kind"] as string,
    evidence: payload["evidence"] as OrphanEvidence | undefined,
  };
}

/** Record an operator-authorized adjudication for the incident anchored on
 *  `incidentId` (the failed task's id). Returns the outcome; the CLI maps it to an
 *  exit code and message. Writes exactly one ops.adjudicated event on success, and
 *  nothing on any refusal. */
export function performAdjudicate(incidentId: string, input: AdjudicateInput): AdjudicateResult {
  const db = getDb();

  // ── Resolve the incident (fails closed as "unknown incident" when there is no
  //    live orphaned-work incident to adjudicate) ──
  const task = getTask(incidentId);
  if (!task) return { kind: "unknown", id: incidentId };
  // A live orphaned_work_may_persist incident is, by the detector's own contract
  // (detect.ts: WHERE t.status = 'failed'), a FAILED task. A recovered/re-dispatched
  // task (complete/running/…) has no such incident — treat it as unknown rather than
  // adjudicate a state that is not the one the operator saw.
  if (task.status !== "failed") {
    return { kind: "unknown", id: incidentId };
  }
  const payload = latestFailedPayload(db, incidentId);
  if (!payload) return { kind: "unknown", id: incidentId };

  // ── Scope: exactly orphaned_work_may_persist × no_unique_work. Scope on the
  //    INCIDENT kind the detector EMITS (via the shared mapping), not the raw
  //    failure_kind: container_crash / idle_timeout / result_missing /
  //    fanout_wave_orphaned all present as an orphaned_work_may_persist incident
  //    and must be adjudicable. A kind that maps to another incident (oom_killed,
  //    orphaned_needs_finalize) is still refused by name. ──
  const failureKind = payload["failure_kind"];
  const incidentKind = typeof failureKind === "string" ? incidentKindForFailureKind(failureKind) : undefined;
  if (incidentKind !== SUPPORTED_KIND) {
    return {
      kind: "refused",
      id: incidentId,
      reason: `unsupported incident kind: task ${incidentId}'s failure_kind ${
        typeof failureKind === "string" ? failureKind : "(unrecorded)"
      } presents as ${incidentKind ? `an ${incidentKind}` : "no"} incident, not a ${SUPPORTED_KIND} incident — this verb adjudicates only ${SUPPORTED_KIND} incidents`,
    };
  }
  if (input.outcome !== SUPPORTED_OUTCOME) {
    return {
      kind: "refused",
      id: incidentId,
      reason: `unsupported outcome: ${input.outcome || "(none)"} — this verb records only the ${SUPPORTED_OUTCOME} outcome`,
    };
  }

  // ── Non-empty rationale (an audit record with no reason is not audit history) ──
  if (input.rationale.trim().length === 0) {
    return {
      kind: "refused",
      id: incidentId,
      reason: `missing rationale: an adjudication must record WHY the incident was retired — none was supplied`,
    };
  }

  // ── Project match: the incident's run must belong to the scoped project. Reading
  //    identity from a verified anchor, never from a caller-asserted field. ──
  const run = getRun(task.runId);
  if (!run) {
    // A failed task whose run is gone cannot have its project confirmed — fail closed.
    return { kind: "refused", id: incidentId, reason: `project mismatch: run ${task.runId} for task ${incidentId} not found` };
  }
  // FG-693: compare through the canonical filesystem-identity contract, not raw
  // string equality — a legitimately-matching project reached through a symlinked
  // or differently-spelled path must not fail closed. ACTING-class projection
  // (provenSameOnly): an unproven identity never authorizes the write, so a
  // genuine mismatch (or an unresolvable path) is still refused by name.
  if (run.projectDir == null || !provenSameOnly(run.projectDir, input.projectDir)) {
    return {
      kind: "refused",
      id: incidentId,
      reason: `project mismatch: incident belongs to project ${run.projectDir ?? "(none)"}, not the scoped project ${input.projectDir}`,
    };
  }

  // ── Identity: the current incident identity, derived only via the canonical
  //    function. If the operator supplied the identity they inspected and it no
  //    longer matches, refuse by naming both (identity drift). ──
  const currentIdentity = computeAdjudicationIdentity(identityInputFor(task.runId, incidentId, payload));
  if (input.expectedIdentity !== currentIdentity) {
    return {
      kind: "refused",
      id: incidentId,
      reason: `identity drift: the incident's current identity (${currentIdentity}) no longer matches the inspected record (${input.expectedIdentity}) — the failed task's work evidence materially changed since you inspected it; re-inspect and adjudicate the current incident`,
    };
  }

  // ── The write: a compare-and-set on identity INSIDE the transaction, mirroring
  //    repairResurrectedGateDecision's CAS-on-observed-state (repair.ts). Recompute
  //    the identity from the CURRENT latest task.failed at write time; refuse if it
  //    changed since resolution (a concurrent re-dispatch appended a new task.failed
  //    in the window) or drifted from what the operator inspected. Exactly ONE event
  //    is written; on refusal, none. ──
  const at = nowIso();
  const result = writeTransaction((): AdjudicateResult => {
    // Re-read the row + latest failure UNDER the write lock. A concurrent recover/
    // retry can move the row off 'failed' or append a fresh task.failed between the
    // checks above and this write; either changes the incident out from under us.
    const liveStatus = (db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(incidentId) as { status: string } | undefined)?.status;
    if (liveStatus !== "failed") {
      return { kind: "refused", id: incidentId, reason: `identity drift: task ${incidentId} is now ${liveStatus ?? "gone"}, no longer a live ${SUPPORTED_KIND} incident — nothing was written` };
    }
    const livePayload = latestFailedPayload(db, incidentId);
    const liveFailureKind = livePayload?.["failure_kind"];
    if (!livePayload || typeof liveFailureKind !== "string" || incidentKindForFailureKind(liveFailureKind) !== SUPPORTED_KIND) {
      return { kind: "refused", id: incidentId, reason: `identity drift: task ${incidentId}'s current failure no longer presents as a ${SUPPORTED_KIND} incident — nothing was written` };
    }
    const writeIdentity = computeAdjudicationIdentity(identityInputFor(task.runId, incidentId, livePayload));
    if (writeIdentity !== currentIdentity || writeIdentity !== input.expectedIdentity) {
      return {
        kind: "refused",
        id: incidentId,
        reason: `identity drift: the incident's identity changed to ${writeIdentity} between inspection and the write — nothing was written; re-inspect and adjudicate the current incident`,
      };
    }
    // Append-only: one ops.adjudicated event, carrying the durable audit record.
    // NO task/run/result/evidence write of any kind.
    logEvent("ops.adjudicated", {
      runId: task.runId,
      taskId: incidentId,
      payload: {
        incidentId: `ops-incident:${SUPPORTED_KIND}:${task.runId}:${incidentId}`,
        kind: SUPPORTED_KIND,
        outcome: SUPPORTED_OUTCOME,
        rationale: input.rationale,
        actor: input.actor,
        identity: writeIdentity,
        at,
      },
    });
    return { kind: "adjudicated", taskId: incidentId, runId: task.runId, identity: writeIdentity, outcome: SUPPORTED_OUTCOME, actor: input.actor, at };
  });

  return result;
}
